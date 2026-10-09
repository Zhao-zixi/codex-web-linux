import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { X509Certificate } from "node:crypto"
import { generateRemoteWorkspaceFiles, initializeRemoteWorkspace } from "./remote-workspace-lib"

const repositoryRoot = path.resolve(import.meta.dir, "..")
const browserImage = "kanna-remote-workspace-browser-e2e:1.64.0"
const sharedHostname = "fnos.zixizhao.top"
const outputRoot = await mkdtemp(path.join(os.tmpdir(), "kanna-shared-browser-e2e-"))
const outputDir = path.join(outputRoot, "deployment")
const screenshotOutputDirectory = "/tmp/kanna-v1-ui"
const project = `kanna-shared-${Date.now().toString(36)}`
const browserNetwork = `${project}-browser`
let caddyId = ""
let composeStarted = false
let networkCreated = false
let probeContainerName = ""

function run(executable: string, args: string[], options: { input?: string | Buffer; allowFailure?: boolean } = {}) {
  const result = spawnSync(executable, args, {
    cwd: repositoryRoot,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  })
  if (result.error) throw new Error(`${executable} could not run`)
  if (result.status !== 0 && !options.allowFailure) {
    const detail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-6).join("\n")
    throw new Error(`${executable} failed${detail ? `: ${detail}` : ""}`)
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function compose(args: string[]) {
  return run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), ...args], { allowFailure: false })
}

function protectedPortSnapshot() {
  const output = run("docker", ["ps", "--format", "{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}"])
  return output.stdout.split("\n").filter((line) => /(?:^|[, ])(?:[^, ]*?:)?(?:80|443|8443)->/.test(line)).sort()
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  assert(address && typeof address !== "string")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitForHttps(port: number, publicCa: string) {
  const deadline = Date.now() + 60_000
  let lastStatus = "000"
  while (Date.now() < deadline) {
    const result = run("curl", [
      "--noproxy", "*", "--silent", "--show-error", "--output", "/dev/null", "--write-out", "%{http_code}",
      "--cacert", publicCa, "--resolve", `${sharedHostname}:${port}:127.0.0.1`, `https://${sharedHostname}:${port}/health`,
    ], { allowFailure: true })
    lastStatus = result.stdout.trim() || "000"
    if (result.status === 0 && lastStatus === "200") return
    await Bun.sleep(500)
  }
  throw new Error(`shared HTTPS health check did not become ready (status ${lastStatus})`)
}

async function waitForInternalCa() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const result = run("docker", [
      "compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"),
      "exec", "-T", "caddy", "test", "-s", "/data/caddy/pki/authorities/local/root.crt",
    ], { allowFailure: true })
    if (result.status === 0) return
    await Bun.sleep(500)
  }
  throw new Error("Caddy internal public root certificate was not initialized")
}

async function writeBrowserFixture() {
  const workspace = path.join(outputDir, "state", "elim", "workspace", "kanna-browser-fixture")
  await mkdir(workspace, { recursive: true })
  await writeFile(path.join(workspace, "pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p0sAAAAASUVORK5CYII=",
    "base64",
  ))
  await writeFile(path.join(workspace, "fixture.html"), "<!doctype html><script>window.kannaFixtureExecuted=true</script><title>Kanna shared browser fixture</title><p>fixture</p>\n")
  await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(4 * 1024 * 1024, 0x4b))
  await writeFile(path.join(workspace, "sample.webm"), await readFile(path.join(repositoryRoot, "scripts/fixtures/remote-workspace-browser.webm")))
  return "/workspace/kanna-browser-fixture"
}

async function verifyCaddyCookieStripping(publicCa: string, webPort: number) {
  const networkOutput = run("docker", ["inspect", "--format", "{{range $name, $network := .NetworkSettings.Networks}}{{println $name}}{{end}}", caddyId]).stdout
  const accountNetwork = networkOutput.split("\n").find((name) => name.endsWith("_account_elim"))
  assert(accountNetwork, "Caddy is missing the isolated account network")
  probeContainerName = `${project}-cookie-probe`
  const probeServer = [
    "const http = require('node:http')",
    "http.createServer((req, res) => {",
    "  res.setHeader('Set-Cookie', 'upstream-sentinel=must-be-removed; Path=/')",
    "  res.setHeader('Content-Type', 'application/json')",
    "  res.end(JSON.stringify({ cookieReceived: Boolean(req.headers.cookie) }))",
    "}).listen(8080, '0.0.0.0')",
  ].join(";")
  run("docker", ["run", "--detach", "--name", probeContainerName, "--network", accountNetwork, "--network-alias", "cookie-probe", browserImage, "node", "-e", probeServer])

  const caddyFile = path.join(outputDir, "Caddyfile")
  const original = await readFile(caddyFile)
  const originalText = original.toString("utf8")
  const probeText = originalText.replace("http://kanna_elim:3210", "http://cookie-probe:8080")
  assert.notEqual(probeText, originalText, "generated Caddy route did not contain the expected account upstream")
  await writeFile(caddyFile, probeText, { mode: 0o600 })
  try {
    compose(["up", "-d", "--no-deps", "--force-recreate", "caddy"])
    await waitForHttps(webPort, publicCa)
    const headersPath = path.join(outputRoot, "probe-response-headers.txt")
    const bodyPath = path.join(outputRoot, "probe-response.json")
    const response = run("curl", [
      "--noproxy", "*", "--silent", "--show-error", "--dump-header", headersPath,
      "--output", bodyPath, "--write-out", "%{http_code}", "--cacert", publicCa,
      "--resolve", `${sharedHostname}:${webPort}:127.0.0.1`,
      "--header", "Cookie: fnos-sentinel=sentinel; account-sentinel=sentinel",
      `https://${sharedHostname}:${webPort}/health`,
    ])
    assert.equal(response.stdout.trim(), "200", "Caddy cookie probe did not reach its upstream")
    const probeResponse = JSON.parse(await readFile(bodyPath, "utf8")) as { cookieReceived?: unknown }
    assert.equal(probeResponse.cookieReceived, false, "Caddy forwarded an incoming Cookie header to its upstream")
    const downstreamHeaders = await readFile(headersPath, "utf8")
    assert(!downstreamHeaders.split("\n").some((line) => /^set-cookie\s*:/i.test(line)), "Caddy forwarded an upstream Set-Cookie header to the browser")
  } finally {
    await writeFile(caddyFile, original, { mode: 0o600 })
    compose(["up", "-d", "--no-deps", "--force-recreate", "caddy"])
  }
  run("docker", ["rm", "--force", probeContainerName], { allowFailure: true })
  probeContainerName = ""
}

try {
  const startingProtectedPorts = protectedPortSnapshot()
  const uid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
  const gid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
  const clientKeys = { elim: path.join(outputRoot, "elim-test-client-ed25519"), zzx: path.join(outputRoot, "zzx-test-client-ed25519") }
  for (const [name, filePath] of Object.entries(clientKeys)) {
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `kanna-browser-e2e-${name}`, "-f", filePath])
  }
  const publicKeys = {
    elim: `${clientKeys.elim}.pub`,
    zzx: `${clientKeys.zzx}.pub`,
  }
  const webPorts = [await unusedPort(), await unusedPort()]
  const sshPorts = [await unusedPort(), await unusedPort()]
  await initializeRemoteWorkspace({
    outputDir,
    domain: sharedHostname,
    publicHostname: sharedHostname,
    hostnameMode: "shared",
    tls: { mode: "internal" },
    accounts: [
      { name: "elim", sshPort: sshPorts[0]!, webPort: webPorts[0]! },
      { name: "zzx", sshPort: sshPorts[1]!, webPort: webPorts[1]! },
    ],
    runtimeUid: uid,
    runtimeGid: gid,
    publicKeys,
  })
  const projectPath = await writeBrowserFixture()
  await generateRemoteWorkspaceFiles(outputDir)
  const generatedCompose = await readFile(path.join(outputDir, "compose.yaml"), "utf8")
  let composeFile = generatedCompose
  for (const port of webPorts) {
    composeFile = composeFile.replace(`"${port}:${port}"`, `"127.0.0.1:${port}:${port}"`)
  }
  await writeFile(path.join(outputDir, "compose.yaml"), composeFile)
  for (const port of webPorts) {
    assert(composeFile.includes(`127.0.0.1:${port}:${port}`), `shared browser port ${port} is not loopback-only`)
  }
  assert(!/\b(?:80|443|8443):(80|443|8443)\b/.test(composeFile), "shared browser fixture must not publish fnOS ports")

  const imageCheck = run("docker", ["image", "inspect", browserImage], { allowFailure: true })
  assert(imageCheck.status === 0, `required isolated browser image is missing: ${browserImage}`)
  composeStarted = true
  const noBuild = process.env.REMOTE_WORKSPACE_SHARED_E2E_NO_BUILD === "1"
  compose(["up", "-d", ...(noBuild ? ["--no-build"] : ["--build"]), "caddy", "kanna_elim", "kanna_zzx"])
  caddyId = compose(["ps", "-q", "caddy"]).stdout.trim()
  assert(caddyId.length > 0, "shared Caddy service did not start")

  await waitForInternalCa()
  const publicCa = path.join(outputRoot, "caddy-root-public.crt")
  compose(["cp", "caddy:/data/caddy/pki/authorities/local/root.crt", publicCa])
  const ca = new X509Certificate(await readFile(publicCa))
  assert(ca.ca, "Caddy internal root export is not a CA certificate")
  const fingerprint = ca.fingerprint256
  await chmod(publicCa, 0o644)

  for (const port of webPorts) await waitForHttps(port, publicCa)
  await verifyCaddyCookieStripping(publicCa, webPorts[0]!)
  caddyId = compose(["ps", "-q", "caddy"]).stdout.trim()
  run("docker", ["network", "create", "--driver", "bridge", "--internal", browserNetwork])
  networkCreated = true
  run("docker", ["network", "connect", "--alias", sharedHostname, browserNetwork, caddyId])
  run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "restart", "caddy"])
  const caAfterRestartPath = path.join(outputRoot, "caddy-root-after-restart.crt")
  compose(["cp", "caddy:/data/caddy/pki/authorities/local/root.crt", caAfterRestartPath])
  const caAfterRestart = new X509Certificate(await readFile(caAfterRestartPath))
  assert.equal(caAfterRestart.fingerprint256, fingerprint, "Caddy CA identity changed after a Caddy restart")
  for (const port of webPorts) await waitForHttps(port, publicCa)

  const browserScript = path.join(repositoryRoot, "scripts/remote-workspace.shared-browser.browser.cjs")
  await mkdir(screenshotOutputDirectory, { recursive: true, mode: 0o700 })
  const browserArgs = [
    "run", "--interactive", "--rm", "--network", browserNetwork,
    "--mount", `type=bind,source=${publicCa},target=/test/root.crt,readonly`,
    "--mount", `type=bind,source=${browserScript},target=/test/browser.cjs,readonly`,
    "--mount", `type=bind,source=${screenshotOutputDirectory},target=/test/output`,
    browserImage,
    "bash", "-lc",
    "set -eu; export HOME=/tmp/kanna-browser-home; mkdir -p \"$HOME/.pki/nssdb\"; certutil -N -d \"sql:$HOME/.pki/nssdb\" --empty-password; certutil -A -d \"sql:$HOME/.pki/nssdb\" -n Kanna-E2E-Root -t 'C,,' -i /test/root.crt; NODE_PATH=/usr/lib/node_modules node /test/browser.cjs \"$@\"",
    "kanna-browser-e2e",
    `https://${sharedHostname}:${webPorts[0]}`,
    `https://${sharedHostname}:${webPorts[1]}`,
    projectPath,
  ]
  const passwordInput = Buffer.concat([
    await readFile(path.join(outputDir, "secrets", "elim", "app-password")),
    await readFile(path.join(outputDir, "secrets", "zzx", "app-password")),
  ])
  const browserResult = run("docker", browserArgs, { input: passwordInput })
  const resultLine = browserResult.stdout.trim().split("\n").at(-1) ?? "{}"
  const result = JSON.parse(resultLine) as { result?: string; [key: string]: unknown }
  assert.equal(result.result, "pass", "strict-TLS browser E2E did not pass")
  assert.equal(startingProtectedPorts.length, protectedPortSnapshot().length, "shared E2E changed a pre-existing protected-port service")
  assert.deepEqual(startingProtectedPorts, protectedPortSnapshot(), "shared E2E changed a pre-existing protected-port mapping")
  process.stdout.write(`${JSON.stringify({ ...result, internalCaFingerprint: fingerprint, protectedPortServicesUnchanged: true, webPorts })}\n`)
} finally {
  if (probeContainerName) run("docker", ["rm", "--force", probeContainerName], { allowFailure: true })
  if (composeStarted) {
    run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "down", "--volumes", "--remove-orphans"], { allowFailure: true })
  }
  if (networkCreated) {
    run("docker", ["network", "rm", browserNetwork], { allowFailure: true })
  }
  await rm(outputRoot, { recursive: true, force: true })
}
