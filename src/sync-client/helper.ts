import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { chmod, copyFile, link, lstat, mkdir, opendir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { inflateRawSync } from "node:zlib"
import os from "node:os"
import path from "node:path"
import { renderLocalSyncUi } from "./local-ui"

declare const KANNA_SYNC_SERVER_ORIGIN: string

const MUTAGEN_ASSETS = {
  linux: {
    url: "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_linux_amd64_v0.18.1.tar.gz",
    sha256: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  },
  windows: {
    url: "https://github.com/mutagen-io/mutagen/releases/download/v0.18.1/mutagen_windows_amd64_v0.18.1.zip",
    sha256: "76f8223d5e6b607efdd9516473669ae5492e4f142887352d59bc6934d1f07a2d",
  },
} as const
const PORTABLE_GIT = {
  url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.2/PortableGit-2.56.0.2-64-bit.7z.exe",
  sha256: "075e158ef8e1f0ab80b347e245405d3eca735c2dc88fd8e032e137d0ca61f61b",
}
const MAX_DOWNLOAD_BYTES = 140 * 1024 * 1024
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_LISTED_DIRECTORIES = 500
const LOCAL_UI_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
}

export type SyncClientState = "connected" | "scanning" | "syncing" | "paused" | "conflicts" | "error" | "stopped" | "unknown"
export interface LocalSyncStatus {
  phase: "ready" | "starting" | "active" | "paused" | "error"
  step: string | null
  localDirectory: string | null
  remotePath: string | null
  sessionName: string | null
  error: string | null
  dependencies: { ssh: boolean; sshKeygen: boolean; mutagen: boolean }
  sync: {
    state: SyncClientState
    summary: string
    conflictCount: number
    conflicts: Array<{ path: string; alpha: string; beta: string }>
    raw: Record<string, unknown> | null
  }
}

interface LocalState {
  serverOrigin: string
  localDirectory: string
  remotePath: string
  sessionName: string
  deviceId: string
  keyPath: string
  sshHost: string
  sshPort: number
  sshUser: string
  publicHostKey: string
  remoteDirectoryCreated: boolean
}

interface MutagenSession {
  identifier: string
  name?: string
  status: string
  paused: boolean
  lastError?: string
  successfulCycles?: number
  conflicts?: Array<{ root?: string; alphaChanges?: Array<{ path?: string }>; betaChanges?: Array<{ path?: string }> }>
  excludedConflicts?: number
  alpha?: { connected?: boolean; scanned?: boolean; directories?: number }
  beta?: { connected?: boolean; scanned?: boolean; directories?: number }
}

class HelperError extends Error {
  constructor(readonly code: string) { super(code) }
}

function commandExists(command: string, env: NodeJS.ProcessEnv = process.env) {
  const result = spawnSync(command, ["-V"], { env, stdio: "ignore", windowsHide: true })
  return !result.error || result.error.code !== "ENOENT"
}

function secureEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function quotePosix(value: string) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quoteSshConfig(value: string) {
  return JSON.stringify(value)
}

function safeError(error: unknown) {
  if (error instanceof HelperError) return error.code
  return "sync_failed"
}

function safeHtmlHeaders() {
  return { ...LOCAL_UI_HEADERS, "Content-Type": "text/html; charset=utf-8" }
}

function executableSuffix() {
  return process.platform === "win32" ? ".exe" : ""
}

export async function extractMutagenZipEntries(archive: Buffer, directory: string) {
  let endOffset = -1
  for (let index = archive.length - 22; index >= Math.max(0, archive.length - 22 - 0xffff); index--) {
    if (archive.readUInt32LE(index) === 0x06054b50) { endOffset = index; break }
  }
  if (endOffset < 0) throw new HelperError("mutagen_install_failed")
  const count = archive.readUInt16LE(endOffset + 10)
  const centralOffset = archive.readUInt32LE(endOffset + 16)
  let offset = centralOffset
  const extracted: string[] = []
  for (let index = 0; index < count; index++) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) throw new HelperError("mutagen_install_failed")
    const flags = archive.readUInt16LE(offset + 8)
    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const uncompressedSize = archive.readUInt32LE(offset + 24)
    const filenameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const filename = archive.toString("utf8", offset + 46, offset + 46 + filenameLength)
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) throw new HelperError("mutagen_install_failed")
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const localName = archive.toString("utf8", localOffset + 30, localOffset + 30 + localNameLength)
    if (localName !== filename) throw new HelperError("mutagen_install_failed")
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (flags & ~0x0808 || dataEnd > archive.length || filename.includes("/") || filename.includes("\\") || (filename !== "mutagen.exe" && filename !== "mutagen-agents.tar.gz")) {
      throw new HelperError("mutagen_install_failed")
    }
    const compressed = archive.subarray(dataStart, dataEnd)
    let contents: Buffer
    if (method === 0) contents = Buffer.from(compressed)
    else if (method === 8) contents = inflateRawSync(compressed)
    else throw new HelperError("mutagen_install_failed")
    if (contents.length !== uncompressedSize) throw new HelperError("mutagen_install_failed")
    extracted.push(filename)
    await writeFile(path.join(directory, filename), contents, { mode: 0o700 })
    offset += 46 + filenameLength + extraLength + commentLength
  }
  return extracted
}

async function downloadVerified(url: string, sha256: string, destination: string) {
  let response: Response
  try { response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) }) }
  catch { throw new HelperError("download_failed") }
  if (!response.ok) throw new HelperError("download_failed")
  const declaredLength = Number(response.headers.get("content-length") ?? 0)
  if (declaredLength > MAX_DOWNLOAD_BYTES) throw new HelperError("download_failed")
  const contents = Buffer.from(await response.arrayBuffer())
  if (contents.length === 0 || contents.length > MAX_DOWNLOAD_BYTES || createHash("sha256").update(contents).digest("hex") !== sha256) {
    throw new HelperError("download_verification_failed")
  }
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 })
  await rename(temporary, destination)
  return contents
}

async function copyBundledVerified(source: string, sha256: string, destination: string) {
  let contents: Buffer
  try { contents = await readFile(source) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw new HelperError("download_failed")
  }
  if (createHash("sha256").update(contents).digest("hex") !== sha256) throw new HelperError("download_verification_failed")
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporary, contents, { flag: "wx", mode: 0o600 })
  await rename(temporary, destination)
  return true
}

function statusFromMutagen(session: MutagenSession | undefined): LocalSyncStatus["sync"] {
  if (!session) return { state: "stopped", summary: "尚未运行同步会话", conflictCount: 0, conflicts: [], raw: null }
  const conflictCount = (session.conflicts?.length ?? 0) + (session.excludedConflicts ?? 0)
  const state: SyncClientState = session.paused
    ? "paused"
    : conflictCount > 0
      ? "conflicts"
      : session.lastError
        ? "error"
        : session.status === "watching"
          ? "connected"
          : session.status === "scanning" || session.status === "waitingForRescan"
            ? "scanning"
            : session.status === "disconnected"
              ? "error"
              : "syncing"
  const conflicts = (session.conflicts ?? []).slice(0, 100).map((conflict) => ({
    path: String(conflict.root ?? "").slice(0, 2000),
    alpha: (conflict.alphaChanges ?? []).map((change) => change.path ?? "").filter(Boolean).slice(0, 8).join(", "),
    beta: (conflict.betaChanges ?? []).map((change) => change.path ?? "").filter(Boolean).slice(0, 8).join(", "),
  }))
  const raw = {
    status: session.status,
    paused: session.paused,
    successfulCycles: session.successfulCycles ?? 0,
    lastError: session.lastError?.slice(0, 1000) ?? null,
    alpha: { connected: !!session.alpha?.connected, scanned: !!session.alpha?.scanned, directories: session.alpha?.directories ?? 0 },
    beta: { connected: !!session.beta?.connected, scanned: !!session.beta?.scanned, directories: session.beta?.directories ?? 0 },
    conflictCount,
    conflicts,
  }
  const summary = session.paused ? "同步已暂停"
    : conflictCount ? `发现 ${conflictCount} 个冲突`
      : session.lastError ? "同步遇到错误"
        : session.status === "watching" ? "已连接，正在监视文件变化"
          : session.status === "scanning" ? "正在扫描两端文件"
            : session.status === "disconnected" ? "连接中断，Mutagen 正在重试"
              : `同步状态：${session.status}`
  return { state, summary, conflictCount, conflicts, raw }
}

export class RemoteWorkspaceSyncHelper {
  readonly token = randomBytes(32).toString("base64url")
  readonly origin: string
  readonly dataDirectory: string
  private accountDataDirectory: string
  private state: LocalState | null = null
  private selectedDirectory: string | null = null
  private phase: LocalSyncStatus["phase"] = "ready"
  private operationBusy = false
  private step: string | null = null
  private error: string | null = null
  private sync = statusFromMutagen(undefined)
  private mutagenPath: string
  private sshPath: string
  private sshKeygenPath: string

  constructor(origin: string, dataDirectory = defaultDataDirectory()) {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || !["https:", "http:"].includes(parsed.protocol)) throw new HelperError("invalid_server_origin")
    this.origin = origin
    this.dataDirectory = dataDirectory
    this.accountDataDirectory = dataDirectory
    this.mutagenPath = path.join(dataDirectory, "tools", `mutagen${executableSuffix()}`)
    this.sshPath = process.platform === "win32" ? path.join(dataDirectory, "tools", "git", "usr", "bin", "ssh.exe") : "ssh"
    this.sshKeygenPath = process.platform === "win32" ? path.join(dataDirectory, "tools", "git", "usr", "bin", "ssh-keygen.exe") : "ssh-keygen"
  }

  private async loadState() {
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.accountDataDirectory, "state.json"), "utf8"))
      if (isRecord(parsed) && parsed.serverOrigin === this.origin && typeof parsed.localDirectory === "string" && typeof parsed.remotePath === "string" && typeof parsed.sessionName === "string" && typeof parsed.keyPath === "string") this.state = parsed as unknown as LocalState
    } catch { /* a missing or invalid state starts a fresh helper session */ }
  }

  async initialize() {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    await chmod(this.dataDirectory, 0o700)
    try {
      const active = (await readFile(path.join(this.dataDirectory, "active-account"), "utf8")).trim()
      if (/^[a-f0-9]{64}$/.test(active)) this.accountDataDirectory = path.join(this.dataDirectory, "accounts", active)
    } catch { /* no previously selected account */ }
    await mkdir(this.accountDataDirectory, { recursive: true, mode: 0o700 })
    await this.ensureSshDispatchers()
    await this.loadState()
    if (this.state) {
      this.selectedDirectory = this.state.localDirectory
      if (await this.hasMutagen()) {
        try { this.sync = await this.readMutagenStatus() }
        catch { this.error = "mutagen_status_unavailable" }
        if (this.sync.state === "stopped") { this.phase = "error"; this.error = "session_not_found" }
        else if (this.sync.state === "paused") this.phase = "paused"
        else if (this.sync.state === "error") this.phase = "error"
        else this.phase = "active"
      }
    }
  }

  private async hasMutagen() {
    try { return (await stat(this.mutagenPath)).isFile() } catch { return false }
  }

  private async ensureSshDispatchers() {
    const directory = path.join(this.dataDirectory, "tools", "ssh-dispatcher")
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const source = await stat(process.execPath)
    for (const name of ["ssh", "scp"]) {
      const target = path.join(directory, `${name}${executableSuffix()}`)
      try {
        const current = await stat(target)
        if (current.dev === source.dev && current.ino === source.ino) continue
      } catch { /* first install */ }
      const temporary = `${target}.${randomBytes(6).toString("hex")}.tmp`
      try { await link(process.execPath, temporary) }
      catch {
        try { await copyFile(process.execPath, temporary) }
        catch { throw new HelperError("ssh_dispatcher_install_failed") }
      }
      try { await rename(temporary, target) }
      catch {
        await rm(target, { force: true })
        await rename(temporary, target).catch(() => { throw new HelperError("ssh_dispatcher_install_failed") })
      }
      if (process.platform !== "win32") await chmod(target, 0o700)
    }
  }

  private get gitBinDirectory() { return path.dirname(this.sshPath) }

  private commandEnvironment(): NodeJS.ProcessEnv {
    const sshHome = path.join(this.accountDataDirectory, "ssh-home")
    const dispatcherDirectory = path.join(this.dataDirectory, "tools", "ssh-dispatcher")
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MUTAGEN_DATA_DIRECTORY: path.join(this.accountDataDirectory, "mutagen-data"),
      MUTAGEN_SSH_PATH: dispatcherDirectory,
      KANNA_SYNC_SSH_CONFIG: path.join(sshHome, ".ssh", "config"),
      KANNA_SYNC_REAL_SSH_PATH: this.sshPath,
      KANNA_SYNC_REAL_SCP_PATH: process.platform === "win32" ? path.join(this.gitBinDirectory, "scp.exe") : "scp",
    }
    if (process.platform === "win32") env.PATH = `${this.gitBinDirectory};${path.join(this.dataDirectory, "tools", "git", "mingw64", "bin")};${env.PATH ?? ""}`
    return env
  }

  private async dependencies() {
    const installedMutagen = await this.hasMutagen()
    const env = this.commandEnvironment()
    return {
      ssh: process.platform === "win32" ? (await Bun.file(this.sshPath).exists()) : commandExists("ssh", env) && commandExists("scp", env),
      sshKeygen: process.platform === "win32" ? (await Bun.file(this.sshKeygenPath).exists()) : commandExists("ssh-keygen", env),
      mutagen: installedMutagen,
    }
  }

  private async mutagenSessions(): Promise<MutagenSession[]> {
    const result = await runCommand(this.mutagenPath, ["sync", "list", "--template", "{{json .}}"], { env: this.commandEnvironment(), timeoutMs: 20_000 })
    const sessions: unknown = JSON.parse(result.stdout.trim() || "[]")
    if (!Array.isArray(sessions)) throw new HelperError("mutagen_status_unavailable")
    return sessions.filter((session): session is MutagenSession => isRecord(session) && typeof session.name === "string")
  }

  private async createMutagenSession() {
    if (!this.state) throw new HelperError("session_not_found")
    const selected = this.state.localDirectory
    const endpoint = `kanna-sync:${this.state.remotePath}`
    await this.mutagen([
      "sync", "create", "--no-global-configuration", "--name", this.state.sessionName,
      "--mode", "two-way-safe", "--ignore-vcs",
      "--ignore", ".kanna", "--ignore", ".codex", "--ignore", ".remote-workspace", "--ignore", ".ssh",
      "--ignore", "node_modules", "--ignore", "vendor", "--ignore", ".venv", "--ignore", "venv",
      "--ignore", "target", "--ignore", "dist", "--ignore", "build", "--ignore", ".next", "--ignore", ".turbo",
      "--ignore", ".cache", "--ignore", ".pytest_cache", "--ignore", "__pycache__", "--ignore", ".env",
      "--ignore", ".env.*", "--ignore", "secrets", "--ignore", "*.pem", "--ignore", "*.key", "--ignore", ".aws/credentials",
      selected, endpoint,
    ])
  }

  private async ensureMutagenSession() {
    if (!this.state) throw new HelperError("session_not_found")
    const sessions = await this.mutagenSessions()
    if (sessions.some((session) => session.name === this.state!.sessionName)) return
    this.step = "creating_remote_directory"
    const directoryExists = await runCommand(this.sshPath, ["-F", path.join(this.accountDataDirectory, "ssh-home", ".ssh", "config"), "kanna-sync", `test -d ${quotePosix(this.state.remotePath)}`], { env: this.commandEnvironment(), timeoutMs: 15_000, allowFailure: true })
    if (directoryExists.status !== 0) await this.sshRemote(`mkdir -p -- ${quotePosix(this.state.remotePath)}`)
    this.step = "connecting_mutagen"
    await this.createMutagenSession()
  }

  private async readMutagenStatus() {
    if (!this.state) return statusFromMutagen(undefined)
    const session = (await this.mutagenSessions()).find((item) => item.name === this.state!.sessionName)
    return statusFromMutagen(session)
  }

  async getStatus(): Promise<LocalSyncStatus> {
    if (this.state && await this.hasMutagen()) {
      try {
        this.sync = await this.readMutagenStatus()
        if (this.phase !== "starting") {
          if (this.sync.state === "paused") this.phase = "paused"
          else if (this.sync.state === "error") this.phase = "error"
          else if (this.sync.state !== "stopped") this.phase = "active"
          else this.phase = "error"
        }
      } catch { this.sync = { ...this.sync, state: "error", summary: "无法读取 Mutagen 状态" } }
    }
    return {
      phase: this.phase,
      step: this.step,
      localDirectory: this.state?.localDirectory ?? this.selectedDirectory,
      remotePath: this.state?.remotePath ?? null,
      sessionName: this.state?.sessionName ?? null,
      error: this.error,
      dependencies: await this.dependencies(),
      sync: this.sync,
    }
  }

  async browse(inputPath: string) {
    const requested = inputPath.trim() || os.homedir()
    let directory: string
    const requestedPath = path.resolve(requested)
    try {
      if ((await lstat(requestedPath)).isSymbolicLink()) throw new Error("symlink")
      directory = await realpath(requestedPath)
    }
    catch { throw new HelperError("directory_unavailable") }
    const directoryInfo = await lstat(directory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new HelperError("directory_unavailable")
    const parent = path.dirname(directory)
    const entries: Array<{ name: string; path: string }> = []
    try {
      const handle = await opendir(directory)
      for await (const entry of handle) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue
        entries.push({ name: entry.name, path: path.join(directory, entry.name) })
        if (entries.length >= MAX_LISTED_DIRECTORIES) break
      }
    } catch { throw new HelperError("directory_unavailable") }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    return { currentPath: directory, parentPath: parent === directory ? null : parent, entries }
  }

  async selectDirectory(inputPath: unknown) {
    if (typeof inputPath !== "string" || !path.isAbsolute(inputPath)) throw new HelperError("directory_unavailable")
    let selected: string
    try {
      if ((await lstat(inputPath)).isSymbolicLink()) throw new Error("symlink")
      selected = await realpath(inputPath)
    } catch { throw new HelperError("directory_unavailable") }
    if (!(await stat(selected)).isDirectory()) throw new HelperError("directory_unavailable")
    if (await this.isUnsafeLocalDirectory(selected)) throw new HelperError("unsafe_local_directory")
    this.selectedDirectory = selected
    return { localDirectory: selected }
  }

  private async isUnsafeLocalDirectory(selected: string) {
    const home = await realpath(os.homedir()).catch(() => path.resolve(os.homedir()))
    const data = await realpath(this.dataDirectory).catch(() => path.resolve(this.dataDirectory))
    const contains = (parent: string, child: string) => {
      const relative = path.relative(parent, child)
      return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
    }
    const root = path.parse(selected).root
    return path.relative(home, selected) === "" || selected === root || contains(selected, data) || contains(data, selected)
  }

  private async saveState() {
    if (!this.state) return
    const file = path.join(this.accountDataDirectory, "state.json")
    const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`
    await writeFile(temp, `${JSON.stringify(this.state, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await rename(temp, file)
    await chmod(file, 0o600)
  }

  private async installMutagen() {
    if (await this.hasMutagen()) return
    this.step = "downloading_mutagen"
    const toolsDirectory = path.dirname(this.mutagenPath)
    await mkdir(toolsDirectory, { recursive: true, mode: 0o700 })
    const release = process.platform === "win32" ? MUTAGEN_ASSETS.windows : MUTAGEN_ASSETS.linux
    const archivePath = path.join(toolsDirectory, process.platform === "win32" ? "mutagen.zip" : "mutagen.tar.gz")
    const bundledName = process.platform === "win32" ? "mutagen-windows-x64.zip" : "mutagen-linux-x64.tar.gz"
    const bundledPath = path.join(path.dirname(process.execPath), bundledName)
    const bundled = await copyBundledVerified(bundledPath, release.sha256, archivePath)
    const archive = bundled ? await readFile(archivePath) : await downloadVerified(release.url, release.sha256, archivePath)
    this.step = "installing_mutagen"
    if (process.platform === "win32") {
      const names = await extractMutagenZipEntries(archive, toolsDirectory)
      await Promise.all(names.map(async (name) => {
        const file = path.join(toolsDirectory, name)
        if (!(await Bun.file(file).exists())) throw new HelperError("mutagen_install_failed")
      }))
    } else {
      const result = spawnSync("tar", ["-xzf", archivePath, "-C", toolsDirectory, "mutagen", "mutagen-agents.tar.gz"], { encoding: "utf8", windowsHide: true })
      if (result.error || result.status !== 0) throw new HelperError("mutagen_install_failed")
      await rename(path.join(toolsDirectory, "mutagen"), this.mutagenPath)
      await chmod(this.mutagenPath, 0o700)
    }
    await rm(archivePath, { force: true })
    if (!(await this.hasMutagen())) throw new HelperError("mutagen_install_failed")
  }

  private async installWindowsSsh() {
    if (process.platform !== "win32") return
    if (await Bun.file(this.sshKeygenPath).exists() && await Bun.file(this.sshPath).exists()) return
    this.step = "downloading_ssh"
    const toolsDirectory = path.join(this.dataDirectory, "tools")
    await mkdir(toolsDirectory, { recursive: true, mode: 0o700 })
    const installer = path.join(toolsDirectory, "PortableGit.7z.exe")
    const bundledGit = path.join(path.dirname(process.execPath), "PortableGit-2.56.0.2-64-bit.7z.exe")
    const hasBundledGit = await copyBundledVerified(bundledGit, PORTABLE_GIT.sha256, installer)
    if (!hasBundledGit) await downloadVerified(PORTABLE_GIT.url, PORTABLE_GIT.sha256, installer)
    this.step = "installing_ssh"
    const destination = path.join(toolsDirectory, "git")
    const result = await runCommand(installer, [`-o${destination}`, "-y"], { env: process.env, timeoutMs: 120_000, allowFailure: true }).catch(() => ({ status: 1, stdout: "", stderr: "" }))
    if (result.status !== 0 || !(await Bun.file(this.sshPath).exists()) || !(await Bun.file(this.sshKeygenPath).exists() && await Bun.file(path.join(this.gitBinDirectory, "scp.exe")).exists())) {
      throw new HelperError("ssh_install_failed")
    }
    await rm(installer, { force: true })
  }

  private async authenticate(username: string, password: string) {
    let response: Response
    try {
      response = await fetch(`${this.origin}/auth/login`, {
        method: "POST",
        headers: { Origin: this.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch { throw new HelperError("authentication_failed") }
    if (!response.ok) throw new HelperError(response.status === 401 ? "invalid_credentials" : "authentication_failed")
    const payload: unknown = await response.json().catch(() => null)
    if (!isRecord(payload) || typeof payload.token !== "string" || payload.token.length < 32 || !isRecord(payload.user)) throw new HelperError("authentication_failed")
    return { token: payload.token, accountId: typeof payload.user.accountId === "string" ? payload.user.accountId : null }
  }

  private async apiJson<T>(token: string, endpoint: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.origin}${endpoint}`, {
        ...init,
        headers: {
          Origin: this.origin,
          Authorization: `Bearer ${token}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: AbortSignal.timeout(30_000),
      })
    } catch { throw new HelperError("authentication_failed") }
    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null)
      if (isRecord(payload) && typeof payload.error === "string") throw new HelperError(payload.error)
      throw new HelperError("authentication_failed")
    }
    return await response.json() as T
  }

  private async createKey() {
    if (!this.state) throw new HelperError("sync_failed")
    await mkdir(path.dirname(this.state.keyPath), { recursive: true, mode: 0o700 })
    if (!(await Bun.file(this.state.keyPath).exists())) {
      const result = spawnSync(this.sshKeygenPath, ["-q", "-t", "ed25519", "-N", "", "-C", `kanna-sync-${os.hostname().slice(0, 40)}`, "-f", this.state.keyPath], { env: this.commandEnvironment(), stdio: "ignore", windowsHide: true })
      if (result.error || result.status !== 0) throw new HelperError("ssh_keygen_failed")
      if (process.platform !== "win32") await chmod(this.state.keyPath, 0o600)
    }
    const key = await readFile(`${this.state.keyPath}.pub`, "utf8")
    if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}(?: [^\r\n]{0,256})?\r?\n?$/.test(key)) throw new HelperError("ssh_keygen_failed")
    return key.trim()
  }

  private async writeSshConfig() {
    if (!this.state) throw new HelperError("sync_failed")
    const sshHome = path.join(this.accountDataDirectory, "ssh-home")
    const sshDirectory = path.join(sshHome, ".ssh")
    await mkdir(sshDirectory, { recursive: true, mode: 0o700 })
    if (process.platform !== "win32") await chmod(sshDirectory, 0o700)
    const knownHosts = path.join(sshDirectory, "known_hosts")
    const knownHostKey = this.state.sshPort === 22 ? this.state.sshHost : `[${this.state.sshHost}]:${this.state.sshPort}`
    await writeFile(knownHosts, `${knownHostKey} ${this.state.publicHostKey}\n`, { mode: 0o600 })
    const config = [
      "Host kanna-sync",
      `  HostName ${this.state.sshHost}`,
      `  Port ${this.state.sshPort}`,
      `  User ${this.state.sshUser}`,
      `  IdentityFile ${quoteSshConfig(this.state.keyPath)}`,
      "  IdentitiesOnly yes",
      "  IdentityAgent none",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${quoteSshConfig(knownHosts)}`,
      `  GlobalKnownHostsFile ${process.platform === "win32" ? "NUL" : "/dev/null"}`,
      "  UpdateHostKeys no",
      "  BatchMode yes",
      "  ConnectTimeout 5",
      "",
    ].join("\n")
    await writeFile(path.join(sshDirectory, "config"), config, { mode: 0o600 })
    if (process.platform !== "win32") await chmod(path.join(sshDirectory, "config"), 0o600)
  }

  private async sshRemote(command: string) {
    if (!this.state) throw new HelperError("sync_failed")
    const configPath = path.join(this.accountDataDirectory, "ssh-home", ".ssh", "config")
    await runCommand(this.sshPath, ["-F", configPath, "kanna-sync", command], { env: this.commandEnvironment(), timeoutMs: 30_000 })
  }

  private async mutagen(args: string[], timeoutMs = 60_000) {
    await runCommand(this.mutagenPath, args, { env: this.commandEnvironment(), timeoutMs })
  }

  async start(input: unknown) {
    if (this.operationBusy) throw new HelperError("operation_in_progress")
    this.operationBusy = true
    try { return await this.runStart(input) }
    catch (error) {
      this.error = safeError(error)
      this.phase = "error"
      this.step = null
      throw error
    }
    finally {
      if (isRecord(input) && typeof input.password === "string") input.password = ""
      this.operationBusy = false
    }
  }

  private async runStart(input: unknown) {
    if (!isRecord(input) || typeof input.username !== "string" || typeof input.password !== "string" || typeof input.localDirectory !== "string") throw new HelperError("invalid_request")
    if (input.username.trim().length < 1 || input.username.length > 128 || input.password.length < 1 || input.password.length > 1024) throw new HelperError("invalid_request")
    const selected = await realpath(input.localDirectory).catch(() => "")
    if (!selected || !(await stat(selected).catch(() => null))?.isDirectory()) throw new HelperError("directory_unavailable")
    if (await this.isUnsafeLocalDirectory(selected)) throw new HelperError("unsafe_local_directory")
    const projectName = path.basename(selected).trim()
    if (!projectName || projectName === "." || projectName === ".." || projectName.includes("/") || /[\0-\x1f\x7f]/.test(projectName) || projectName.length > 120) throw new HelperError("invalid_project_directory")

    let password = input.password
    let bearer = ""
    this.phase = "starting"
    this.error = null
    this.step = "checking_dependencies"
    try {
      await this.installWindowsSsh()
      await this.installMutagen()
      const dependencies = await this.dependencies()
      if (!dependencies.ssh || !dependencies.sshKeygen) throw new HelperError("ssh_unavailable")
      const authenticated = await this.authenticate(input.username.trim(), password)
      bearer = authenticated.token
      if (typeof authenticated.accountId !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/i.test(authenticated.accountId)) throw new HelperError("workspace_unavailable")
      const accountHash = createHash("sha256").update(`${this.origin}\0${authenticated.accountId}`).digest("hex")
      this.accountDataDirectory = path.join(this.dataDirectory, "accounts", accountHash)
      await mkdir(this.accountDataDirectory, { recursive: true, mode: 0o700 })
      await chmod(this.accountDataDirectory, 0o700)
      this.state = null
      await this.loadState()
      if (this.state && this.state.localDirectory !== selected) throw new HelperError("another_project_active")
      await writeFile(path.join(this.dataDirectory, "active-account"), `${accountHash}\n`, { mode: 0o600 })
      await chmod(path.join(this.dataDirectory, "active-account"), 0o600)
      this.step = "loading_connection"
      const hosted = await this.apiJson<Record<string, unknown>>(bearer, "/api/hosted-workspace")
      if (typeof hosted.sshHost !== "string" || !/^[a-z0-9.-]+$/i.test(hosted.sshHost) || !Number.isInteger(hosted.sshPort) || Number(hosted.sshPort) < 1 || Number(hosted.sshPort) > 65535 || typeof hosted.sshUser !== "string" || !/^[a-z_][a-z0-9_-]*[$]?$/i.test(hosted.sshUser) || hosted.workspaceRoot !== "/workspace" || typeof hosted.publicHostKey !== "string" || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: .{0,256})?$/.test(hosted.publicHostKey)) throw new HelperError("invalid_hosted_workspace")
      if (!this.state || this.state.serverOrigin !== this.origin || this.state.localDirectory !== selected) {
        const suffix = createHash("sha256").update(`${this.origin}\0${selected}`).digest("hex").slice(0, 12)
        this.state = {
          serverOrigin: this.origin,
          localDirectory: selected,
          remotePath: `/workspace/${projectName}`,
          sessionName: `kanna-${accountHash.slice(0, 8)}-${suffix}`,
          deviceId: "",
          keyPath: path.join(this.accountDataDirectory, "device-ed25519"),
          sshHost: hosted.sshHost,
          sshPort: hosted.sshPort as number,
          sshUser: hosted.sshUser,
          publicHostKey: hosted.publicHostKey,
          remoteDirectoryCreated: false,
        }
      } else {
        this.state.sshHost = hosted.sshHost
        this.state.sshPort = hosted.sshPort as number
        this.state.sshUser = hosted.sshUser
        this.state.publicHostKey = hosted.publicHostKey
      }
      this.selectedDirectory = selected
      this.step = "creating_device_key"
      const publicKey = await this.createKey()
      const fingerprint = createHash("sha256").update(publicKey).digest("hex")
      const label = `Kanna Sync ${os.hostname().slice(0, 48)}`
      this.step = "registering_device"
      const enrolled = await this.apiJson<{ deviceId: string; authorized: boolean }>(bearer, "/api/hosted-workspace/devices", {
        method: "POST",
        body: JSON.stringify({ publicKey, label }),
      })
      if (!enrolled.authorized || typeof enrolled.deviceId !== "string") throw new HelperError("device_enrollment_failed")
      this.state.deviceId = enrolled.deviceId
      await this.saveState()
      this.step = "verifying_host_key"
      await this.writeSshConfig()
      await this.ensureMutagenSession()
      await this.saveState()
      this.step = null
      this.sync = await this.readMutagenStatus()
      this.phase = this.sync.state === "paused" ? "paused" : "active"
      this.selectedDirectory = selected
      return await this.getStatus()
    } catch (error) {
      this.error = safeError(error)
      this.phase = "error"
      this.step = null
      throw new HelperError(this.error)
    } finally {
      if (bearer) {
        try { await fetch(`${this.origin}/auth/logout?scope=session`, { method: "POST", headers: { Origin: this.origin, Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5_000) }) } catch { /* logout is best effort */ }
      }
      bearer = ""
      password = ""
      input.password = ""
    }
  }

  async control(action: "pause" | "resume" | "restart" | "open-kanna") {
    if (this.operationBusy) throw new HelperError("operation_in_progress")
    this.operationBusy = true
    try { return await this.runControl(action) }
    finally { this.operationBusy = false }
  }

  private async runControl(action: "pause" | "resume" | "restart" | "open-kanna") {
    if (action === "open-kanna") {
      openInBrowser(this.origin)
      return await this.getStatus()
    }
    if (!this.state) throw new HelperError("session_not_found")
    if (action === "pause") await this.mutagen(["sync", "pause", this.state.sessionName])
    else if (action === "resume") await this.mutagen(["sync", "resume", this.state.sessionName])
    else {
      this.step = "reconnecting"
      await this.writeSshConfig()
      const sessions = await this.mutagenSessions()
      if (sessions.some((session) => session.name === this.state!.sessionName)) await this.mutagen(["sync", "resume", this.state.sessionName])
      else await this.ensureMutagenSession()
      this.step = null
    }
    this.sync = await this.readMutagenStatus()
    this.phase = this.sync.state === "paused" ? "paused" : this.sync.state === "error" ? "error" : "active"
    this.error = null
    return await this.getStatus()
  }

  async handle(request: Request, port: number, remoteAddress?: string) {
    const localOrigin = `http://127.0.0.1:${port}`
    const expectedHost = `127.0.0.1:${port}`
    const url = new URL(request.url)
    if (remoteAddress && remoteAddress !== "127.0.0.1" && remoteAddress !== "::ffff:127.0.0.1") return new Response("Not found", { status: 404 })
    if (request.headers.get("host") !== expectedHost || url.hostname !== "127.0.0.1" || url.port !== String(port)) return new Response("Bad request", { status: 400 })
    const secFetchSite = request.headers.get("sec-fetch-site")
    if (secFetchSite === "cross-site") return new Response("Forbidden", { status: 403 })
    const requestOrigin = request.headers.get("origin")
    if (requestOrigin && requestOrigin !== localOrigin) return new Response("Forbidden", { status: 403 })
    const isApi = url.pathname.startsWith("/api/")
    if (isApi && !secureEqual(request.headers.get("x-kanna-token") ?? "", this.token)) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } })
    if (request.method === "OPTIONS") return new Response(null, { status: 405 })
    if (isApi && request.method !== "GET" && requestOrigin !== localOrigin) return Response.json({ error: "invalid_origin" }, { status: 403, headers: { "Cache-Control": "no-store" } })
    if (url.pathname === "/" && request.method === "GET") return new Response(renderLocalSyncUi({ serverOrigin: this.origin }), { headers: safeHtmlHeaders() })
    if (!isApi) return new Response("Not found", { status: 404, headers: LOCAL_UI_HEADERS })
    if (url.pathname === "/api/status" && request.method === "GET") return Response.json(await this.getStatus(), { headers: { "Cache-Control": "no-store" } })
    if (url.pathname === "/api/browse" && request.method === "GET") {
      try { return Response.json(await this.browse(url.searchParams.get("path") ?? ""), { headers: { "Cache-Control": "no-store" } }) }
      catch (error) { return Response.json({ error: safeError(error) }, { status: 400, headers: { "Cache-Control": "no-store" } }) }
    }
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
    if (["pause", "resume", "restart", "open-kanna"].some((action) => url.pathname === `/api/${action}`)) {
      try {
        const action = url.pathname.slice("/api/".length) as "pause" | "resume" | "restart" | "open-kanna"
        return Response.json(await this.control(action), { headers: { "Cache-Control": "no-store" } })
      } catch (error) {
        const code = safeError(error)
        this.error = code
        return Response.json({ error: code }, { status: code === "invalid_request" ? 400 : 409, headers: { "Cache-Control": "no-store" } })
      }
    }
    const body = await readJsonBody(request)
    if (!body) return Response.json({ error: "invalid_request" }, { status: 400, headers: { "Cache-Control": "no-store" } })
    try {
      if (url.pathname === "/api/select-directory") return Response.json(await this.selectDirectory(body.path), { headers: { "Cache-Control": "no-store" } })
      if (url.pathname === "/api/start") {
        if (this.operationBusy) return Response.json({ error: "operation_in_progress" }, { status: 409, headers: { "Cache-Control": "no-store" } })
        void this.start(body).catch(() => undefined)
        return Response.json(await this.getStatus(), { status: 202, headers: { "Cache-Control": "no-store" } })
      }
      return new Response("Not found", { status: 404, headers: LOCAL_UI_HEADERS })
    } catch (error) {
      const code = safeError(error)
      this.error = code
      return Response.json({ error: code }, { status: code === "invalid_request" ? 400 : 409, headers: { "Cache-Control": "no-store" } })
    }
  }
}

export function defaultDataDirectory() {
  if (process.env.KANNA_SYNC_DATA_DIRECTORY) return path.resolve(process.env.KANNA_SYNC_DATA_DIRECTORY)
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "KannaSync")
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "kanna-sync")
}

export function getEmbeddedServerOrigin() {
  return typeof KANNA_SYNC_SERVER_ORIGIN === "undefined" ? "" : KANNA_SYNC_SERVER_ORIGIN
}

export async function readConnectionFile(filePath: string, embeddedOrigin = getEmbeddedServerOrigin()) {
  const value: unknown = JSON.parse(await readFile(filePath, "utf8"))
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.serverOrigin !== embeddedOrigin || typeof value.serverOrigin !== "string") throw new HelperError("invalid_server_origin")
  return value.serverOrigin
}

export function startLocalSyncServer(helper: RemoteWorkspaceSyncHelper) {
  let server: ReturnType<typeof Bun.serve>
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 255,
    fetch: (request) => helper.handle(request, server.port, server.requestIP(request)?.address),
  })
  const localUrl = `http://127.0.0.1:${server.port}/#${helper.token}`
  const startupFile = process.env.KANNA_SYNC_STARTUP_FILE
  if (startupFile) {
    const resolvedStartupFile = path.resolve(startupFile)
    mkdirSync(path.dirname(resolvedStartupFile), { recursive: true, mode: 0o700 })
    const temporary = `${resolvedStartupFile}.${randomBytes(6).toString("hex")}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ localUrl })}\n`, { flag: "wx", mode: 0o600 })
    chmodSync(temporary, 0o600)
    renameSync(temporary, resolvedStartupFile)
    chmodSync(resolvedStartupFile, 0o600)
  }
  if (process.env.KANNA_SYNC_NO_OPEN !== "1") openInBrowser(localUrl)
  return { server, localUrl }
}

function openInBrowser(url: string) {
  let command: string
  let args: string[]
  if (process.platform === "win32") { command = "cmd.exe"; args = ["/c", "start", "", url] }
  else if (process.platform === "darwin") { command = "open"; args = [url] }
  else { command = "xdg-open"; args = [url] }
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true })
    child.once("error", () => undefined)
    child.unref()
  } catch { /* the user can open the local UI manually if the platform opener is unavailable */ }
}

function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length") ?? 0)
  if (contentLength > MAX_REQUEST_BYTES || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return Promise.resolve(null)
  return request.text().then((text) => {
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return null
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : null
  }).catch(() => null)
}

function runCommand(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs: number; allowFailure?: boolean }) {
  return new Promise<{ stdout: string; stderr: string; status: number }>((resolve, reject) => {
    const child = spawn(command, args, { env: options.env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const append = (current: string, chunk: Buffer) => (current + chunk.toString("utf8")).slice(-32_000)
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => child.kill(), options.timeoutMs)
    child.once("error", () => { clearTimeout(timer); reject(new HelperError(command.includes("ssh") ? "ssh_unavailable" : "sync_failed")) })
    child.once("close", (code) => {
      clearTimeout(timer)
      const status = code ?? 1
      if (status !== 0 && !options.allowFailure) reject(new HelperError(command.includes("ssh") ? "ssh_connection_failed" : "sync_failed"))
      else resolve({ stdout, stderr, status })
    })
  })
}
