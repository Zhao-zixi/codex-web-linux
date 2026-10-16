import { chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import {
  enableRemoteWorkspaceGateway,
  generateRemoteWorkspaceFiles,
  initializeRemoteWorkspace,
} from "./remote-workspace-lib"

const timeout = 180_000
const root = await mkdtemp(path.join(os.tmpdir(), "kanna sync helper e2e-"))
const outputDir = path.join(root, "deployment")
const clientRoot = path.join(root, "client bundle")
const helperData = path.join(root, "helper private data")
const localProject = path.join(root, "local projects", "project with spaces")
const legacyKey = path.join(root, "legacy-device")
const gatewayPort = await unusedPort()
const aliceSshPort = await unusedPort()
const bobSshPort = await unusedPort()
const aliceWebPort = await unusedPort()
const bobWebPort = await unusedPort()
const publicHostname = "sync-client.example.test"
const gatewayOrigin = `http://127.0.0.1:${gatewayPort}`
const runtimeUid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
const runtimeGid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
const projectName = path.basename(localProject)
const projectId = `sync-client-e2e-${randomBytes(5).toString("hex")}`
let composeStarted = false
let helperProcess: ReturnType<typeof spawn> | null = null
let helperToken = ""
let helperOrigin = ""
let helperEnv: NodeJS.ProcessEnv = {}
let accountData = ""
let sessionName = ""

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeout?: number; allowFailure?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? timeout,
    maxBuffer: 2 * 1024 * 1024,
    input: options.input,
    stdio: options.input === undefined ? ["ignore", "pipe", "pipe"] : undefined,
  })
  if (result.error || (!options.allowFailure && result.status !== 0)) {
    throw new Error(`${command} failed in isolated sync E2E (status=${result.status ?? "spawn error"})`)
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}

function commandExists(command: string) {
  return spawnSync("which", [command], { stdio: "ignore" }).status === 0
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to allocate isolated E2E port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

function api(pathname: string, init: RequestInit = {}) {
  return fetch(`${helperOrigin}${pathname}`, {
    ...init,
    headers: { "X-Kanna-Token": helperToken, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  })
}

async function waitFor<T>(label: string, operation: () => Promise<T | null>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await operation()
    if (value !== null) return value
    if (helperProcess?.exitCode !== null && helperProcess?.exitCode !== undefined) throw new Error(`${label}: compiled helper exited early`)
    await Bun.sleep(300)
  }
  throw new Error(`${label}: timed out`)
}

async function startCompiledHelper(expectedPhase = "ready") {
  const startupFile = path.join(root, "startup", "helper.json")
  await rm(startupFile, { force: true })
  helperEnv = { ...process.env, KANNA_SYNC_DATA_DIRECTORY: helperData, KANNA_SYNC_NO_OPEN: "1", KANNA_SYNC_STARTUP_FILE: startupFile }
  delete helperEnv.SSH_AUTH_SOCK
  delete helperEnv.MUTAGEN_DATA_DIRECTORY
  helperProcess = spawn(path.join(clientRoot, "kanna-sync"), [], { cwd: clientRoot, env: helperEnv, stdio: "ignore", windowsHide: true })
  helperProcess.once("error", () => undefined)
  const local = await waitFor("compiled helper startup file", async () => {
    try { return JSON.parse(await readFile(startupFile, "utf8")) as { localUrl: string } } catch { return null }
  })
  const localUrl = new URL(local.localUrl)
  helperOrigin = localUrl.origin
  helperToken = localUrl.hash.slice(1)
  if (!helperToken || localUrl.hostname !== "127.0.0.1") throw new Error("Compiled helper did not bind an authenticated loopback URL")
  const ready = await waitFor("compiled helper local status", async () => {
    const response = await api("/api/status").catch(() => null)
    if (!response) return null
    if (!response.ok) return null
    return await response.json() as { phase: string }
  })
  if (ready.phase !== expectedPhase) throw new Error(`Compiled helper began in unexpected phase (${ready.phase})`)
}

function stopCompiledHelper() {
  if (!helperProcess || helperProcess.exitCode !== null) return
  helperProcess.kill("SIGTERM")
}

async function waitForSyncFile(localFile: string, remoteFile: string, expected: string, label: string) {
  const deadline = Date.now() + 45_000
  while (Date.now() < deadline) {
    const local = await readFile(localFile, "utf8").catch(() => "")
    let remote = ""
    try {
      const remoteResult = run("ssh", ["-F", path.join(accountData, "ssh-home", ".ssh", "config"), "kanna-sync", `cat -- ${quote(remoteFile)}`], { env: helperEnv, timeout: 10_000, allowFailure: true })
      if (remoteResult.status === 0) remote = remoteResult.stdout.trim()
    } catch { /* wait for the SSH session to be ready */ }
    if (local.trim() === expected && remote === expected) return
    await Bun.sleep(250)
  }
  throw new Error(`${label}: bidirectional file did not converge`)
}

async function postControl(action: string) {
  const response = await api(`/api/${action}`, { method: "POST", headers: { Origin: helperOrigin } })
  if (!response.ok) throw new Error(`Compiled helper ${action} request failed with HTTP ${response.status}`)
}

try {
  for (const command of ["docker", "ssh", "ssh-keygen", "unzip", "sha256sum"]) {
    if (!commandExists(command)) throw new Error(`Sync client E2E requires ${command}`)
  }
  run("docker", ["info"], { timeout: 20_000 })
  await mkdir(localProject, { recursive: true })
  await writeFile(path.join(localProject, "from-local.txt"), "local initial\n")
  await writeFile(path.join(localProject, ".env"), "must remain local\n")
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", legacyKey])

  await initializeRemoteWorkspace({
    outputDir,
    domain: publicHostname,
    publicHostname,
    hostnameMode: "shared",
    tls: { mode: "none" },
    accounts: [
      { name: "alice", sshPort: aliceSshPort, webPort: aliceWebPort },
      { name: "bob", sshPort: bobSshPort, webPort: bobWebPort },
    ],
    runtimeUid,
    runtimeGid,
    publicKeys: { alice: `${legacyKey}.pub`, bob: `${legacyKey}.pub` },
  })
  await enableRemoteWorkspaceGateway(outputDir, gatewayPort)
  await generateRemoteWorkspaceFiles(outputDir)

  const gatewayConfigPath = path.join(outputDir, "config", "gateway.json")
  const gatewayConfig = JSON.parse(await readFile(gatewayConfigPath, "utf8")) as { publicOrigin: string }
  gatewayConfig.publicOrigin = gatewayOrigin
  await writeFile(gatewayConfigPath, `${JSON.stringify(gatewayConfig, null, 2)}\n`, { mode: 0o644 })
  const aliceConfigPath = path.join(outputDir, "config", "alice.json")
  const aliceConfig = JSON.parse(await readFile(aliceConfigPath, "utf8")) as { sshHost: string; webHost?: string; webPort?: number; webOrigin?: string }
  aliceConfig.sshHost = "127.0.0.1"
  aliceConfig.webHost = "127.0.0.1"
  aliceConfig.webPort = gatewayPort
  aliceConfig.webOrigin = gatewayOrigin
  await writeFile(aliceConfigPath, `${JSON.stringify(aliceConfig, null, 2)}\n`, { mode: 0o644 })
  const bobConfigPath = path.join(outputDir, "config", "bob.json")
  const bobConfig = JSON.parse(await readFile(bobConfigPath, "utf8")) as { webHost?: string; webPort?: number; webOrigin?: string }
  bobConfig.webHost = "127.0.0.1"
  bobConfig.webPort = gatewayPort
  bobConfig.webOrigin = gatewayOrigin
  await writeFile(bobConfigPath, `${JSON.stringify(bobConfig, null, 2)}\n`, { mode: 0o644 })
  const composePath = path.join(outputDir, "compose.yaml")
  let composeText = await readFile(composePath, "utf8")
  for (const port of [aliceSshPort, bobSshPort]) composeText = composeText.replace(`"${port}:2222"`, `"127.0.0.1:${port}:2222"`)
  composeText = composeText.replace(`"${gatewayPort}:3210"`, `"127.0.0.1:${gatewayPort}:3210"`)
  await writeFile(composePath, composeText)
  if (!composeText.includes(`"127.0.0.1:${gatewayPort}:3210"`)) throw new Error("Gateway mapping is not loopback-only")
  console.log("Building and starting isolated Gateway/app/SSH Docker fixture")
  run("docker", ["compose", "-p", projectId, "-f", composePath, "up", "-d", "--build"], { cwd: outputDir, timeout: 900_000 })
  composeStarted = true

  console.log("Waiting for fixture Gateway account login")
  const gatewayPassword = (await readFile(path.join(outputDir, "secrets", "alice", "app-password"), "utf8")).trim()
  await waitFor("Gateway-to-app login", async () => {
    const response = await fetch(`${gatewayOrigin}/auth/login`, {
      method: "POST",
      headers: { Origin: gatewayOrigin, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: gatewayPassword }),
      signal: AbortSignal.timeout(8_000),
    }).catch(() => null)
    if (!response) return null
    if (!response.ok) return null
    return true
  })

  const aliceHostKey = (await readFile(path.join(outputDir, "state", "alice", "ssh-host-ed25519.pub"), "utf8")).trim()
  const bobHostKey = (await readFile(path.join(outputDir, "state", "bob", "ssh-host-ed25519.pub"), "utf8")).trim()
  const legacyKnownHosts = path.join(root, "legacy-known_hosts")
  await writeFile(legacyKnownHosts, `[127.0.0.1]:${aliceSshPort} ${aliceHostKey}\n`)
  const legacySshArgs = ["-F", "/dev/null", "-i", legacyKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${JSON.stringify(legacyKnownHosts)}`, "-p", String(aliceSshPort), "workspace@127.0.0.1"]
  const remoteProject = `/workspace/${projectName}`
  const initialRemote = run("ssh", [...legacySshArgs, `mkdir -p -- ${quote(remoteProject)} && printf '%s\\n' 'remote initial' > ${quote(`${remoteProject}/from-remote.txt`)}`], { timeout: 15_000, allowFailure: true })
  if (initialRemote.status !== 0) throw new Error(`Fixture legacy SSH setup failed: ${initialRemote.stderr.slice(-1200)}`)
  const oldAuthorizedKeys = await readFile(path.join(outputDir, "secrets", "alice", "authorized_keys"), "utf8")

  const bundleOutput = path.join(root, "public clients")
  console.log("Building and extracting the compiled Linux helper bundle")
  run(process.execPath, ["run", "build:sync-client", "--", "--origin", gatewayOrigin, "--output-dir", bundleOutput, "--target", "linux-x64"], { cwd: process.cwd(), timeout: 600_000 })
  const archive = path.join(bundleOutput, "kanna-sync-linux-x64.zip")
  await mkdir(clientRoot, { recursive: true })
  run("unzip", ["-q", archive, "-d", clientRoot])
  const helperPath = path.join(clientRoot, "kanna-sync")
  if (!(await stat(helperPath)).isFile()) throw new Error("Linux helper bundle did not contain the executable")
  await chmod(helperPath, 0o700)
  if (!(await stat(path.join(clientRoot, "mutagen-linux-x64.tar.gz"))).isFile()) throw new Error("Linux helper bundle did not contain pinned Mutagen")

  const accountHash = createHash("sha256").update(`${gatewayOrigin}\0alice`).digest("hex")
  accountData = path.join(helperData, "accounts", accountHash)
  console.log("Starting helper and registering its isolated device key")
  await startCompiledHelper()
  const startResponse = await api("/api/start", {
    method: "POST",
    headers: { Origin: helperOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: gatewayPassword, localDirectory: await realpath(localProject) }),
  })
  if (startResponse.status !== 202) throw new Error(`Compiled helper start returned HTTP ${startResponse.status}`)
  const status = await waitFor("new key SSH and Mutagen sync", async () => {
    const response = await api("/api/status")
    if (!response.ok) return null
    const value = await response.json() as { phase: string; error: string | null; sync: { state: string } }
    if (value.phase === "error") throw new Error(`Compiled helper could not connect (${value.error})`)
    return value.phase === "active" && ["connected", "scanning", "syncing"].includes(value.sync.state) ? value : null
  })
  if (!status) throw new Error("Compiled helper did not report an active Mutagen session")
  const persistedState = JSON.parse(await readFile(path.join(accountData, "state.json"), "utf8")) as { sessionName: string; keyPath: string; sshHost: string; sshPort: number }
  sessionName = persistedState.sessionName
  const devicePrivateKey = persistedState.keyPath
  if (((await stat(devicePrivateKey)).mode & 0o077) !== 0) throw new Error("Device private key permissions are not private")
  await waitForSyncFile(path.join(localProject, "from-remote.txt"), `${remoteProject}/from-remote.txt`, "remote initial", "initial existing remote pull")
  const helperSshConfig = path.join(accountData, "ssh-home", ".ssh", "config")
  const isolatedSshEnv = { ...helperEnv, SSH_AUTH_SOCK: "" }
  const helperSsh = run("ssh", ["-F", helperSshConfig, "kanna-sync", "printf 'new-device-key-ok\\n'"], { env: isolatedSshEnv }).stdout.trim()
  if (helperSsh !== "new-device-key-ok") throw new Error("Mutagen helper device key could not establish an independent SSH connection")
  const remoteLocalFile = `${remoteProject}/from-local.txt`
  await waitForSyncFile(path.join(localProject, "from-local.txt"), remoteLocalFile, "local initial", "initial local push")
  const remoteSecret = run("ssh", ["-F", helperSshConfig, "kanna-sync", `if test -e ${quote(`${remoteProject}/.env`)}; then echo exists; else echo missing; fi`], { env: isolatedSshEnv })
  if (remoteSecret.stdout.trim() !== "missing") throw new Error("Ignored .env file was transferred to the workspace")

  const wrongKnownHosts = path.join(accountData, "ssh-home", ".ssh", "known_hosts")
  const realKnownHosts = await readFile(wrongKnownHosts, "utf8")
  await writeFile(wrongKnownHosts, `[127.0.0.1]:${aliceSshPort} ${bobHostKey}\n`, { mode: 0o600 })
  let wrongHostResult: ReturnType<typeof run>
  try { wrongHostResult = run("ssh", ["-F", helperSshConfig, "kanna-sync", "true"], { env: isolatedSshEnv, allowFailure: true, timeout: 10_000 }) }
  finally { await writeFile(wrongKnownHosts, realKnownHosts, { mode: 0o600 }) }
  if (wrongHostResult.status === 0) throw new Error("SSH accepted a mismatched pinned host key")

  const helperMutagenDirectory = path.join(helperData, "m", path.basename(accountData).slice(0, 24))
  const installedMutagen = path.join(helperData, "tools", "mutagen")
  const mutagenEnv = { ...helperEnv, MUTAGEN_DATA_DIRECTORY: helperMutagenDirectory, MUTAGEN_SSH_PATH: path.join(helperData, "tools", "ssh-dispatcher"), SSH_AUTH_SOCK: "" }
  const sessions = run(installedMutagen, ["sync", "list", "--long", sessionName], { env: mutagenEnv, timeout: 20_000 }).stdout
  if (!sessions.includes("Two Way Safe") || !sessions.includes("127.0.0.1")) throw new Error("Compiled helper Mutagen session did not use the isolated SSH transport")
  await writeFile(path.join(localProject, "later-local.txt"), "later local\n")
  await waitForSyncFile(path.join(localProject, "later-local.txt"), `${remoteProject}/later-local.txt`, "later local", "subsequent local-to-remote sync")
  await run("ssh", ["-F", helperSshConfig, "kanna-sync", `printf '%s\\n' 'later remote' > ${quote(`${remoteProject}/later-remote.txt`)}`], { env: isolatedSshEnv })
  await waitForSyncFile(path.join(localProject, "later-remote.txt"), `${remoteProject}/later-remote.txt`, "later remote", "subsequent remote-to-local sync")

  await postControl("pause")
  const paused = await waitFor("Mutagen pause", async () => {
    const response = await api("/api/status")
    const value = await response.json().catch(() => null) as { sync?: { state?: string } } | null
    return value?.sync?.state === "paused" ? value : null
  })
  if (!paused) throw new Error("Compiled helper did not pause its Mutagen session")
  await writeFile(path.join(localProject, "paused-local.txt"), "after resume\n")
  stopCompiledHelper()
  await new Promise<void>((resolve) => helperProcess?.once("exit", () => resolve()))
  await startCompiledHelper("paused")
  const reopened = await api("/api/status").then((response) => response.json()) as { phase: string; sync: { state: string } }
  if (reopened.phase !== "paused" || reopened.sync.state !== "paused") throw new Error("Reopened compiled helper did not recover its existing paused session")
  await postControl("resume")
  await waitForSyncFile(path.join(localProject, "paused-local.txt"), `${remoteProject}/paused-local.txt`, "after resume", "resume after helper reopen")

  const gatewayLogin = await fetch(`${gatewayOrigin}/auth/login`, {
    method: "POST",
    headers: { Origin: gatewayOrigin, "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: gatewayPassword }),
  })
  if (!gatewayLogin.ok) throw new Error("Fixture Gateway login failed while verifying the registered device")
  const gatewaySession = await gatewayLogin.json() as { token: string; user: { accountId: string | null } }
  if (gatewaySession.user.accountId !== "alice") throw new Error("Gateway did not map the authenticated user to their app account")
  const deviceHeaders = { Origin: gatewayOrigin, Authorization: `Bearer ${gatewaySession.token}` }
  const deviceListResponse = await fetch(`${gatewayOrigin}/api/hosted-workspace/devices`, { headers: deviceHeaders })
  if (!deviceListResponse.ok) throw new Error("Gateway did not proxy the registered device list")
  const devices = await deviceListResponse.json() as { devices: Array<{ id: string; fingerprint: string }> }
  if (devices.devices.length !== 1 || !devices.devices[0]?.id) throw new Error("Gateway device registry did not contain exactly the new helper device")
  const deviceId = devices.devices[0].id
  const deviceAuthorizedKeys = await readFile(path.join(outputDir, "state", "alice", "device-keys", "authorized_keys"), "utf8")
  if (!deviceAuthorizedKeys.includes("kanna-device-v1")) throw new Error("The sidecar-shared account device key volume did not receive the registration")
  if (await readFile(path.join(outputDir, "secrets", "alice", "authorized_keys"), "utf8") !== oldAuthorizedKeys) throw new Error("Device registration modified legacy authorized_keys")

  const bobKnownHosts = path.join(root, "bob-known_hosts")
  await writeFile(bobKnownHosts, `[127.0.0.1]:${bobSshPort} ${bobHostKey}\n`)
  const bobLegacyProbe = run("ssh", ["-F", "/dev/null", "-i", legacyKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${JSON.stringify(bobKnownHosts)}`, "-p", String(bobSshPort), "workspace@127.0.0.1", "printf bob-legacy-ok"], { env: isolatedSshEnv, allowFailure: true, timeout: 10_000 })
  if (bobLegacyProbe.status !== 0 || bobLegacyProbe.stdout.trim() !== "bob-legacy-ok") throw new Error(`Fixture Bob legacy SSH positive control failed: ${bobLegacyProbe.stderr.slice(-1200)}`)
  const crossAccount = run("ssh", ["-F", "/dev/null", "-i", devicePrivateKey, "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${JSON.stringify(bobKnownHosts)}`, "-p", String(bobSshPort), "workspace@127.0.0.1", "true"], { env: isolatedSshEnv, allowFailure: true, timeout: 10_000 })
  if (crossAccount.status === 0) throw new Error("Alice's registered device key was accepted by Bob's SSH sidecar")
  const legacyStillWorks = run("ssh", [...legacySshArgs, "true"], { timeout: 10_000, allowFailure: true })
  if (legacyStillWorks.status !== 0) throw new Error("The pre-existing account SSH key stopped working")

  const revoke = await fetch(`${gatewayOrigin}/api/hosted-workspace/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE", headers: deviceHeaders })
  if (revoke.status !== 204) throw new Error(`Gateway device revoke failed with HTTP ${revoke.status}`)
  const revokedNewKey = run("ssh", ["-F", helperSshConfig, "kanna-sync", "true"], { env: isolatedSshEnv, allowFailure: true, timeout: 10_000 })
  if (revokedNewKey.status === 0) throw new Error("A new SSH connection succeeded after device revocation")
  const legacyAfterRevoke = run("ssh", [...legacySshArgs, "true"], { timeout: 10_000, allowFailure: true })
  if (legacyAfterRevoke.status !== 0) throw new Error("Revoking the helper device removed legacy authorized_keys access")
  await fetch(`${gatewayOrigin}/auth/logout?scope=session`, { method: "POST", headers: deviceHeaders })

  console.log("Compiled Linux sync helper Gateway enrollment, isolated SSH host-key pinning, revocation, reopen and two-way-safe Mutagen E2E passed")
} finally {
  stopCompiledHelper()
  const processToStop = helperProcess as ReturnType<typeof spawn> | null
  if (processToStop && processToStop.exitCode === null) await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    processToStop.once("exit", () => { clearTimeout(timer); resolve() })
  })
  if (helperData && accountData && sessionName) {
    const mutagen = path.join(helperData, "tools", "mutagen", "mutagen")
    const isolated = { ...helperEnv, MUTAGEN_DATA_DIRECTORY: path.join(helperData, "m", path.basename(accountData).slice(0, 24)), MUTAGEN_SSH_PATH: path.join(helperData, "tools", "ssh-dispatcher") }
    if (await Bun.file(mutagen).exists()) {
      spawnSync(mutagen, ["sync", "terminate", sessionName], { env: isolated, stdio: "ignore", timeout: 10_000 })
      spawnSync(mutagen, ["daemon", "stop"], { env: isolated, stdio: "ignore", timeout: 10_000 })
    }
  }
  if (composeStarted) spawnSync("docker", ["compose", "-p", projectId, "-f", path.join(outputDir, "compose.yaml"), "down", "--volumes", "--remove-orphans"], { cwd: outputDir, stdio: "ignore", timeout: 60_000 })
  await rm(root, { recursive: true, force: true })
}
