import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const EXPECTED_MUTAGEN_SHA256 = {
  linux: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  windows: "76f8223d5e6b607efdd9516473669ae5492e4f142887352d59bc6934d1f07a2d",
} as const
const EXPECTED_PORTABLE_GIT_SHA256 = "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b"
const target = process.env.KANNA_SYNC_NATIVE_SMOKE_TARGET
if (target !== "linux-x64" && target !== "windows-x64") throw new Error("KANNA_SYNC_NATIVE_SMOKE_TARGET must be linux-x64 or windows-x64")
if ((process.platform === "win32") !== (target === "windows-x64") || process.arch !== "x64") throw new Error(`Smoke target ${target} does not match native runner ${process.platform}-${process.arch}`)

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-native-smoke-"))
const artifactDirectory = path.join(temporaryRoot, "artifact")
const extractedDirectory = path.join(temporaryRoot, "extracted")
const stateDirectory = path.join(temporaryRoot, "helper-state")
const selectedDirectory = path.join(temporaryRoot, "local-project")
const mutagenAlpha = path.join(temporaryRoot, "mutagen-alpha")
const mutagenBeta = path.join(temporaryRoot, "mutagen-beta")
await Promise.all([artifactDirectory, extractedDirectory, selectedDirectory, mutagenAlpha, mutagenBeta].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 60_000,
    windowsHide: true,
  })
  if (result.error) throw result.error
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function runOk(command: string, args: string[], options: Parameters<typeof run>[2] = {}) {
  const result = run(command, args, options)
  assert(result.status === 0, `${path.basename(command)} ${args.join(" ")} failed (${result.status}): ${(result.stderr || result.stdout).slice(-3000)}`)
  return result.stdout.trim()
}

async function waitFor<T>(description: string, operation: () => Promise<T | null>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError = ""
  while (Date.now() < deadline) {
    try {
      const result = await operation()
      if (result !== null) return result
    } catch (error) { lastError = error instanceof Error ? error.message : String(error) }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError}` : ""}`)
}

function parseMutagenSessions(output: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(output.trim() || "[]")
  assert(Array.isArray(parsed), "Mutagen session listing was not a JSON array")
  return parsed.filter((value): value is Record<string, unknown> => !!value && typeof value === "object")
}

const accountId = "sync-smoke"
const bearer = "native-smoke-token-0123456789abcdef0123456789abcdef"
const publicHostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKf+Zp6q2ehmffnWhQwZm+Z7JL7x7dQhQ/O9eVtS8y9u native-smoke-host"
let registeredPublicKey = ""
let gatewayRequests = 0
const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    gatewayRequests++
    const url = new URL(request.url)
    if (url.pathname === "/auth/login" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { username?: string; password?: string } | null
      if (body?.username !== "smoke-user" || body.password !== "smoke-password") return Response.json({ error: "invalid_credentials" }, { status: 401 })
      return Response.json({ token: bearer, user: { accountId } })
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") return new Response(null, { status: 204 })
    if (request.headers.get("authorization") !== `Bearer ${bearer}`) return Response.json({ error: "unauthorized" }, { status: 401 })
    if (url.pathname === "/api/hosted-workspace" && request.method === "GET") {
      return Response.json({ displayName: "Native smoke", sshHost: "127.0.0.1", sshPort: 1, sshUser: "workspace", workspaceRoot: "/workspace", publicHostKey })
    }
    if (url.pathname === "/api/hosted-workspace/devices" && request.method === "POST") {
      const body = await request.json().catch(() => null) as { publicKey?: string; label?: string } | null
      if (!body?.publicKey?.startsWith("ssh-ed25519 ") || typeof body.label !== "string") return Response.json({ error: "invalid_device" }, { status: 400 })
      registeredPublicKey = body.publicKey
      return Response.json({ deviceId: "native-smoke-device", authorized: true })
    }
    return Response.json({ error: "not_found" }, { status: 404 })
  },
})

const origin = `http://127.0.0.1:${gateway.port}`
const helperData = { KANNA_SYNC_DATA_DIRECTORY: stateDirectory, KANNA_SYNC_NO_OPEN: "1", KANNA_SYNC_STARTUP_FILE: path.join(temporaryRoot, "startup.json") }
let helper: ReturnType<typeof spawn> | null = null
let helperOutput = ""
let helperExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | null = null
const mutagenDataDirectory = path.join(temporaryRoot, "mutagen-data")
let mutagenPath = path.join(stateDirectory, "tools", `mutagen${process.platform === "win32" ? ".exe" : ""}`)
let mutagenEnv: NodeJS.ProcessEnv = { ...process.env, MUTAGEN_DATA_DIRECTORY: mutagenDataDirectory }
let mutagenSessionCreated = false

async function requestLocal(localOrigin: string, token: string, pathname: string, options: { method?: string; body?: unknown; omitOrigin?: boolean; tokenOverride?: string } = {}) {
  const headers = new Headers({ "X-Kanna-Token": options.tokenOverride ?? token })
  if (!options.omitOrigin && options.method && options.method !== "GET") headers.set("Origin", localOrigin)
  if (options.body !== undefined) headers.set("Content-Type", "application/json")
  return await fetch(`${localOrigin}${pathname}`, { method: options.method ?? "GET", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), redirect: "manual" })
}

async function verifyDispatcher(dataDirectory: string, accountDirectory: string) {
  const suffix = process.platform === "win32" ? ".exe" : ""
  const sshDispatcher = path.join(dataDirectory, "tools", "ssh-dispatcher", `ssh${suffix}`)
  const scpDispatcher = path.join(dataDirectory, "tools", "ssh-dispatcher", `scp${suffix}`)
  const sshDirectory = path.join(accountDirectory, "ssh-home", ".ssh")
  const configPath = path.join(sshDirectory, "config")
  const config = await readFile(configPath, "utf8")
  assert(config.includes("HostName 127.0.0.1"), "SSH config is missing the test gateway host")
  assert(config.includes("Port 1"), "SSH config is missing the test SSH port")
  assert(config.includes("StrictHostKeyChecking yes"), "SSH config does not enforce strict host-key checking")
  assert(config.includes("UserKnownHostsFile"), "SSH config does not pin a dedicated known_hosts file")
  const state = JSON.parse(await readFile(path.join(accountDirectory, "state.json"), "utf8")) as { keyPath?: string; sshPort?: number; sshHost?: string }
  assert(typeof state.keyPath === "string" && state.sshHost === "127.0.0.1" && state.sshPort === 1, "active account state is incomplete")
  const accountHash = path.basename(accountDirectory)
  assert((await readFile(path.join(dataDirectory, "active-account"), "utf8")).trim() === accountHash, "helper did not select the isolated fixture account")
  assert((await readFile(`${state.keyPath}.pub`, "utf8")).trim() === registeredPublicKey, "the registered key differs from the generated public key")
  const knownHosts = await readFile(path.join(sshDirectory, "known_hosts"), "utf8")
  assert(knownHosts.includes(publicHostKey), "dedicated known_hosts does not pin the fixture host key")
  const dispatcherEnv: NodeJS.ProcessEnv = {
    ...process.env,
    KANNA_SYNC_SSH_CONFIG: configPath,
    KANNA_SYNC_REAL_SSH_PATH: process.platform === "win32" ? path.join(dataDirectory, "tools", "git", "usr", "bin", "ssh.exe") : "ssh",
    KANNA_SYNC_REAL_SCP_PATH: process.platform === "win32" ? path.join(dataDirectory, "tools", "git", "usr", "bin", "scp.exe") : "scp",
    PATH: process.platform === "win32" ? `${path.join(dataDirectory, "tools", "git", "usr", "bin")};${process.env.PATH ?? ""}` : process.env.PATH,
  }
  const sshVersion = run(dispatcherEnv.KANNA_SYNC_REAL_SSH_PATH!, ["-V"], { env: dispatcherEnv })
  assert(!sshVersion.stderr.includes("not found") && /OpenSSH/i.test(`${sshVersion.stdout}\n${sshVersion.stderr}`), "real SSH executable failed to load")
  const sshKeygenPath = process.platform === "win32" ? path.join(dataDirectory, "tools", "git", "usr", "bin", `ssh-keygen${suffix}`) : "ssh-keygen"
  const scpVersion = run(dispatcherEnv.KANNA_SYNC_REAL_SCP_PATH!, ["-h"], { env: dispatcherEnv })
  assert(/usage: scp/i.test(`${scpVersion.stdout}\n${scpVersion.stderr}`), "real scp executable failed to load")
  const keygenVersion = run(sshKeygenPath, ["-?"], { env: dispatcherEnv })
  assert(/usage: ssh-keygen/i.test(`${keygenVersion.stdout}\n${keygenVersion.stderr}`), "real ssh-keygen executable failed to load")
  const keyCheck = runOk(sshKeygenPath, ["-lf", `${state.keyPath}.pub`], { env: dispatcherEnv })
  assert(keyCheck.includes("SHA256:"), "generated device key is not readable by ssh-keygen")
  if (process.platform !== "win32") {
    const keyMode = (await stat(state.keyPath)).mode & 0o777
    assert(keyMode === 0o600, `generated device private key mode was ${keyMode.toString(8)}, expected 600`)
    assert(((await stat(configPath)).mode & 0o777) === 0o600, "SSH config is not private")
  }
  const dispatcher = run(sshDispatcher, ["-G", "kanna-sync"], { env: dispatcherEnv })
  assert(dispatcher.status === 0, `SSH dispatcher did not start: ${dispatcher.stderr.slice(-2000)}`)
  const outputLines = dispatcher.stdout.split(/\r?\n/)
  const settings = new Map(outputLines.map((line) => {
    const split = line.indexOf(" ")
    return split < 0 ? [line, ""] : [line.slice(0, split), line.slice(split + 1)]
  }))
  assert(settings.get("hostname") === "127.0.0.1" && settings.get("port") === "1", "dispatcher did not force the generated SSH config")
  assert(settings.get("stricthostkeychecking") === "true", "dispatcher did not pass strict host-key policy")
  const expectedIdentity = state.keyPath.replaceAll("\\", "/").toLowerCase()
  assert(outputLines.some((line) => line.startsWith("identityfile ") && line.replaceAll("\\", "/").toLowerCase().includes(expectedIdentity)), "dispatcher did not use the generated account key")
  const knownHostSetting = (settings.get("userknownhostsfile") ?? "").replaceAll("\\", "/").toLowerCase()
  assert(knownHostSetting.includes("known_hosts"), "dispatcher did not use the dedicated known_hosts file")
  assert(await realpath(scpDispatcher).then(() => true, () => false), "scp dispatcher was not installed")
}

async function verifyMutagen(mutagenArchiveName: string) {
  const suffix = process.platform === "win32" ? ".exe" : ""
  mutagenPath = path.join(stateDirectory, "tools", `mutagen${suffix}`)
  assert(await realpath(mutagenPath).then(() => true, () => false), "bundled Mutagen archive was not extracted by the helper")
  mutagenEnv = { ...process.env, MUTAGEN_DATA_DIRECTORY: mutagenDataDirectory }
  const version = runOk(mutagenPath, ["version"], { env: mutagenEnv })
  assert(version.includes("0.18.1"), `unexpected Mutagen version: ${version}`)
  if (process.platform === "win32") {
    assert(await realpath(path.join(stateDirectory, "tools", "mutagen-agents.tar.gz")).then(() => true, () => false), "Windows Mutagen agent bundle was not extracted")
    const gitTools = path.join(stateDirectory, "tools", "git", "usr", "bin")
    for (const tool of ["ssh.exe", "scp.exe", "ssh-keygen.exe"]) assert(await realpath(path.join(gitTools, tool)).then(() => true, () => false), `PortableGit is missing ${tool}`)
  }
  const alphaSeed = path.join(mutagenAlpha, "alpha.txt")
  const betaSeed = path.join(mutagenBeta, "beta.txt")
  await writeFile(alphaSeed, "from alpha\n")
  await writeFile(betaSeed, "from beta\n")
  runOk(mutagenPath, ["sync", "create", "--name", "kanna-native-smoke", "--mode", "two-way-safe", "--ignore-vcs", mutagenAlpha, mutagenBeta], { env: mutagenEnv, timeoutMs: 60_000 })
  mutagenSessionCreated = true
  await waitFor("initial local-to-local two-way sync", async () => {
    const [alpha, beta] = await Promise.all([
      readFile(path.join(mutagenAlpha, "beta.txt"), "utf8").catch(() => null),
      readFile(path.join(mutagenBeta, "alpha.txt"), "utf8").catch(() => null),
    ])
    return alpha === "from beta\n" && beta === "from alpha\n" ? true : null
  })
  runOk(mutagenPath, ["sync", "pause", "kanna-native-smoke"], { env: mutagenEnv })
  await waitFor("Mutagen paused state", async () => {
    const sessions = parseMutagenSessions(runOk(mutagenPath, ["sync", "list", "--template", "{{json .}}"], { env: mutagenEnv }))
    const session = sessions.find((item) => item.name === "kanna-native-smoke")
    return session?.paused === true ? true : null
  })
  const pausedMarker = path.join(mutagenAlpha, "must-wait-for-resume.txt")
  await writeFile(pausedMarker, "paused\n")
  await new Promise((resolve) => setTimeout(resolve, 1500))
  assert(!(await readFile(path.join(mutagenBeta, "must-wait-for-resume.txt"), "utf8").then(() => true, () => false)), "Mutagen copied a change while paused")
  runOk(mutagenPath, ["sync", "resume", "kanna-native-smoke"], { env: mutagenEnv })
  await waitFor("Mutagen resume propagation", async () => await readFile(path.join(mutagenBeta, "must-wait-for-resume.txt"), "utf8").then((contents) => contents === "paused\n" ? true : null, () => null))
  console.log(`Verified bundled ${mutagenArchiveName}, Mutagen 0.18.1 local two-way sync, pause, and resume`)
}

async function verifyClientFlow() {
  const executableName = process.platform === "win32" ? "kanna-sync.exe" : "kanna-sync"
  const executable = path.join(extractedDirectory, executableName)
  assert(await realpath(executable).then(() => true, () => false), `archive is missing ${executableName}`)
  const connection = JSON.parse(await readFile(path.join(extractedDirectory, "connection.json"), "utf8")) as { serverOrigin?: string }
  assert(connection.serverOrigin === origin, "connection.json origin does not match embedded origin")
  const expectedMutagen = process.platform === "win32" ? "mutagen-windows-x64.zip" : "mutagen-linux-x64.tar.gz"
  const mutagenArchive = await readFile(path.join(extractedDirectory, expectedMutagen))
  assert(createHash("sha256").update(mutagenArchive).digest("hex") === EXPECTED_MUTAGEN_SHA256[process.platform === "win32" ? "windows" : "linux"], "bundled Mutagen checksum does not match the pinned release")
  if (process.platform === "win32") {
    const gitArchive = await readFile(path.join(extractedDirectory, "PortableGit-2.56.0.2-64-bit.7z.exe"))
    assert(createHash("sha256").update(gitArchive).digest("hex") === EXPECTED_PORTABLE_GIT_SHA256, "bundled PortableGit checksum does not match the pinned release")
  } else {
    assert(((await stat(executable)).mode & 0o111) !== 0, "Linux helper ZIP did not preserve executable mode")
  }

  helper = spawn(executable, [], { cwd: extractedDirectory, env: { ...process.env, ...helperData }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  helperExit = new Promise((resolve) => helper!.once("exit", (code, signal) => resolve({ code, signal })))
  helper.stdout?.on("data", (chunk: Buffer) => { helperOutput += chunk.toString("utf8") })
  helper.stderr?.on("data", (chunk: Buffer) => { helperOutput += chunk.toString("utf8") })
  const startup = await waitFor("compiled helper startup handoff", async () => {
    if (helper?.exitCode !== null) throw new Error(`compiled helper exited early (${helper?.exitCode}): ${helperOutput}`)
    try { return JSON.parse(await readFile(helperData.KANNA_SYNC_STARTUP_FILE!, "utf8")) as { localUrl?: string } }
    catch { return null }
  })
  assert(typeof startup.localUrl === "string", "startup handoff is missing localUrl")
  if (process.platform !== "win32") assert(((await stat(helperData.KANNA_SYNC_STARTUP_FILE!)).mode & 0o777) === 0o600, "startup handoff file is not mode 0600")
  const startupText = await readFile(helperData.KANNA_SYNC_STARTUP_FILE!, "utf8")
  const startupKeys = Object.keys(JSON.parse(startupText))
  assert(startupKeys.length === 1 && startupKeys[0] === "localUrl", "startup file contains unexpected fields")
  const localUrl = new URL(startup.localUrl)
  assert(localUrl.hostname === "127.0.0.1" && localUrl.hash.length > 1, "helper did not bind loopback with a fragment token")
  const localToken = decodeURIComponent(localUrl.hash.slice(1))
  assert(localToken.length >= 32 && !helperOutput.includes(localToken), "local token is short or leaked to helper output")
  const localOrigin = localUrl.origin

  const unauthorized = await requestLocal(localOrigin, localToken, "/api/status", { tokenOverride: "wrong-token" })
  assert(unauthorized.status === 401, "helper accepted a wrong local API token")
  const readyResponse = await requestLocal(localOrigin, localToken, "/api/status")
  assert(readyResponse.ok, `compiled helper status failed (${readyResponse.status})`)
  const ready = await readyResponse.json() as { phase: string; dependencies: { ssh: boolean; sshKeygen: boolean; mutagen: boolean } }
  assert(ready.phase === "ready", `unexpected initial helper phase: ${ready.phase}`)

  const unauthorizedOrigin = await requestLocal(localOrigin, localToken, "/api/select-directory", { method: "POST", body: { path: selectedDirectory }, omitOrigin: true })
  assert(unauthorizedOrigin.status === 403, "helper accepted a local POST without an exact Origin")
  const browseResponse = await requestLocal(localOrigin, localToken, `/api/browse?path=${encodeURIComponent(temporaryRoot)}`)
  assert(browseResponse.ok, `compiled helper browse failed (${browseResponse.status})`)
  const browse = await browseResponse.json() as { entries: Array<{ path: string }> }
  assert(browse.entries.some((entry) => entry.path === selectedDirectory), "compiled helper directory browser did not list the selected fixture")
  const selectResponse = await requestLocal(localOrigin, localToken, "/api/select-directory", { method: "POST", body: { path: selectedDirectory } })
  assert(selectResponse.ok, `compiled helper directory selection failed (${selectResponse.status})`)
  const startResponse = await requestLocal(localOrigin, localToken, "/api/start", { method: "POST", body: { username: "smoke-user", password: "smoke-password", localDirectory: selectedDirectory } })
  assert(startResponse.status === 202, `compiled helper start was not accepted asynchronously (${startResponse.status})`)
  const terminalStatus = await waitFor("prepared helper to fail only at the closed fixture SSH transport", async () => {
    const response = await requestLocal(localOrigin, localToken, "/api/status")
    if (!response.ok) throw new Error(`status returned ${response.status}`)
    const status = await response.json() as { phase: string; error: string | null; dependencies: { ssh: boolean; sshKeygen: boolean; mutagen: boolean } }
    if (status.phase === "error") return status
    return null
  }, 180_000)
  assert(terminalStatus.error === "ssh_connection_failed", `expected closed-port SSH failure after setup, received ${terminalStatus.error}`)
  assert(terminalStatus.dependencies.ssh && terminalStatus.dependencies.sshKeygen && terminalStatus.dependencies.mutagen, "the helper did not prepare all declared dependencies")
  await verifyMutagen(expectedMutagen)
  assert(registeredPublicKey.startsWith("ssh-ed25519 "), "fake gateway did not receive a generated device public key")
  const accountHash = createHash("sha256").update(`${origin}\0${accountId}`).digest("hex")
  const accountDirectory = path.join(stateDirectory, "accounts", accountHash)
  await verifyDispatcher(stateDirectory, accountDirectory)
  assert(gatewayRequests >= 4, `expected helper requests to fake gateway, saw ${gatewayRequests}`)
  console.log(`Verified actual compiled ${executableName}: startup, local API, bundled tools, generated key, SSH config dispatcher, and expected closed-port transport failure`)
}

async function main() {
  try {
    await mkdir(artifactDirectory, { recursive: true })
    const outputDirectory = artifactDirectory
    const build = run(process.execPath, ["run", "build:sync-client", "--", "--origin", origin, "--output-dir", outputDirectory, "--target", target as "linux-x64" | "windows-x64"], { timeoutMs: 20 * 60_000 })
    assert(build.status === 0, `native client build failed: ${(build.stderr || build.stdout).slice(-5000)}`)
    const archiveName = `kanna-sync-${target}.zip`
    const archivePath = path.join(outputDirectory, archiveName)
    assert((await stat(archivePath)).size > 10_000_000, "native client archive is unexpectedly small")
    await mkdir(extractedDirectory, { recursive: true })
    if (process.platform === "win32") {
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
      runOk("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${literal(archivePath)} -DestinationPath ${literal(extractedDirectory)} -Force`], { timeoutMs: 120_000 })
    } else {
      runOk("unzip", ["-q", "-o", archivePath, "-d", extractedDirectory], { timeoutMs: 120_000 })
    }
    const archiveEntries = (await readdir(extractedDirectory)).sort()
    assert(archiveEntries.includes("connection.json") && archiveEntries.includes(process.platform === "win32" ? "mutagen-windows-x64.zip" : "mutagen-linux-x64.tar.gz"), `archive is missing required entries: ${archiveEntries.join(", ")}`)
    await verifyClientFlow()
  console.log(`Native sync-client smoke passed for ${target}; all fixture files and generated test keys are removed during cleanup`)
  } finally {
    if (helper && helper.exitCode === null) {
      helper.kill("SIGTERM")
      await Promise.race([helperExit, new Promise((resolve) => setTimeout(resolve, 10_000))])
      if (helper.exitCode === null) helper.kill("SIGKILL")
    }
    const candidate = mutagenPath || path.join(stateDirectory, "tools", `mutagen${process.platform === "win32" ? ".exe" : ""}`)
    if (await realpath(candidate).then(() => true, () => false)) {
      if (mutagenSessionCreated) run(candidate, ["sync", "terminate", "kanna-native-smoke"], { env: mutagenEnv, timeoutMs: 20_000 })
      run(candidate, ["daemon", "stop"], { env: mutagenEnv, timeoutMs: 20_000 })
      const accountHash = createHash("sha256").update(`${origin}\0${accountId}`).digest("hex")
      const helperMutagenEnv = { ...process.env, MUTAGEN_DATA_DIRECTORY: path.join(stateDirectory, "accounts", accountHash, "mutagen-data") }
      run(candidate, ["daemon", "stop"], { env: helperMutagenEnv, timeoutMs: 20_000 })
    }
    gateway.stop(true)
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

await main()
