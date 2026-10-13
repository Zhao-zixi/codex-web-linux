import { randomBytes } from "node:crypto"
import { access, chmod, chown, copyFile, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface RemoteWorkspaceAccount {
  name: string
  sshPort: number
  webPort?: number
}

export type RemoteWorkspaceTls =
  | { mode: "external"; certFile: string; keyFile: string }
  | { mode: "internal" }
  | { mode: "none" }

export interface RemoteWorkspaceManifest {
  version: 1
  domain: string
  local: boolean
  runtimeUid: number
  runtimeGid: number
  accounts: RemoteWorkspaceAccount[]
  hostnameMode?: "subdomain" | "shared"
  publicHostname?: string
  tls?: RemoteWorkspaceTls
  gateway?: { enabled: true; publicPort: number }
}

export interface InitRemoteWorkspaceOptions {
  outputDir: string
  domain: string
  accounts: RemoteWorkspaceAccount[]
  local?: boolean
  runtimeUid: number
  runtimeGid: number
  publicKeys: Record<string, string>
  hostnameMode?: "subdomain" | "shared"
  publicHostname?: string
  tls?: RemoteWorkspaceTls
}

const ACCOUNT_NAME = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const MANIFEST_FILE = "manifest.json"
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function validateDomain(value: string) {
  const domain = value.toLowerCase().replace(/\.$/, "")
  if (domain.length > 253 || !domain.includes(".") || domain.split(".").some((label) => !DNS_LABEL.test(label))) {
    throw new Error("Domain must be a valid DNS name with at least two labels")
  }
  return domain
}

export function validateAccountName(value: string) {
  if (!ACCOUNT_NAME.test(value) || value.length > 32) throw new Error(`Invalid account name: ${value}`)
  return value
}

export function validateAccounts(accounts: RemoteWorkspaceAccount[]) {
  if (accounts.length < 1 || accounts.length > 32) throw new Error("Provide between 1 and 32 accounts")
  const names = new Set<string>()
  const ports = new Set<number>()
  const webPorts = new Set<number>()
  for (const account of accounts) {
    validateAccountName(account.name)
    if (names.has(account.name)) throw new Error(`Duplicate account: ${account.name}`)
    names.add(account.name)
    if (!Number.isInteger(account.sshPort) || account.sshPort < 1024 || account.sshPort > 65535) throw new Error(`Invalid SSH port for ${account.name}`)
    if (ports.has(account.sshPort)) throw new Error(`Duplicate SSH port: ${account.sshPort}`)
    ports.add(account.sshPort)
    if (account.webPort !== undefined) {
      if (!Number.isInteger(account.webPort) || account.webPort < 1024 || account.webPort > 65535) throw new Error(`Invalid web port for ${account.name}`)
      if (webPorts.has(account.webPort)) throw new Error(`Duplicate web port: ${account.webPort}`)
      if (ports.has(account.webPort)) throw new Error(`Web port conflicts with an SSH port: ${account.webPort}`)
      webPorts.add(account.webPort)
    }
  }
  for (const port of webPorts) {
    if (ports.has(port)) throw new Error(`Web port conflicts with an SSH port: ${port}`)
  }
}

async function validateExternalTls(tls: RemoteWorkspaceTls) {
  if (!tls || tls.mode !== "external") throw new Error("Shared hostname mode requires external TLS certificate files")
  for (const [label, filePath] of [["certificate", tls.certFile], ["private key", tls.keyFile]] as const) {
    if (typeof filePath !== "string" || !path.isAbsolute(filePath) || filePath.includes("\n") || filePath.includes("\r") || filePath.includes("\0")) {
      throw new Error(`TLS ${label} path must be an absolute file path`)
    }
    let info
    try {
      info = await stat(filePath)
      await access(filePath, fsConstants.R_OK)
    } catch {
      throw new Error(`TLS ${label} file is missing or unreadable`)
    }
    if (!info.isFile()) throw new Error(`TLS ${label} path must name a regular file`)
    if (label === "private key" && ((info.mode & 0o077) !== 0 || (info.mode & 0o400) === 0)) {
      throw new Error("TLS private key must be owner-readable and not readable or writable by group or others")
    }
  }
  if (await realpath(tls.certFile) === await realpath(tls.keyFile)) throw new Error("TLS certificate and private key must be different files")
}

async function validateSharedTls(tls: RemoteWorkspaceTls | undefined) {
  if (!tls) throw new Error("Shared hostname mode requires an explicit TLS mode")
  if (tls.mode === "internal" || tls.mode === "none") {
    if ("certFile" in tls || "keyFile" in tls) throw new Error("This TLS mode cannot include external certificate paths")
    return
  }
  if (tls.mode !== "external") throw new Error("Invalid TLS mode")
  await validateExternalTls(tls)
}

function validateManifestHostname(manifest: RemoteWorkspaceManifest) {
  const mode = manifest.hostnameMode ?? "subdomain"
  if (mode !== "shared" && mode !== "subdomain") throw new Error("Invalid hostname mode")
  if (manifest.local && mode === "shared") throw new Error("Shared hostname mode cannot be combined with local mode")
  if (mode === "shared") {
    if (!manifest.publicHostname) throw new Error("Shared hostname mode requires a public hostname")
    if (validateDomain(manifest.publicHostname) !== manifest.publicHostname) throw new Error("Public hostname must be normalized")
    if (manifest.domain !== manifest.publicHostname) throw new Error("Shared hostname domain must match public hostname")
    if (!manifest.gateway?.enabled && manifest.accounts.some((account) => account.webPort === undefined)) throw new Error("Shared hostname mode requires a distinct web port for every account")
    if (manifest.gateway && (!manifest.gateway.enabled || !Number.isInteger(manifest.gateway.publicPort) || manifest.gateway.publicPort < 1024 || manifest.gateway.publicPort > 65535)) throw new Error("Invalid gateway configuration")
    if (manifest.gateway?.enabled && (manifest.tls?.mode !== "none" || manifest.accounts.some((account) => account.sshPort === manifest.gateway!.publicPort))) {
      throw new Error("The gateway requires plain HTTP and a public port that does not conflict with SSH")
    }
    if (!manifest.tls) throw new Error("Shared hostname mode requires an explicit TLS mode")
    if (manifest.tls.mode === "internal" || manifest.tls.mode === "none") {
      if ("certFile" in manifest.tls || "keyFile" in manifest.tls) throw new Error("This TLS mode cannot include external certificate paths")
    } else if (manifest.tls.mode === "external") {
      // Validated asynchronously by init/add-account/generate.
    } else {
      throw new Error("Invalid TLS mode")
    }
  } else if (manifest.publicHostname !== undefined || manifest.tls !== undefined) {
    throw new Error("External hostname and TLS settings require shared hostname mode")
  }
  return mode
}

function parseOpenSshPublicKey(text: string) {
  const trimmed = text.trim()
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{0,256})?$/.exec(trimmed)
  if (!match) throw new Error("Public key must be one OpenSSH public-key line")
  const blob = Buffer.from(match[2]!, "base64")
  if (blob.length < 8 || blob.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, "")) {
    throw new Error("Public key has invalid base64 data")
  }
  const algorithmLength = blob.readUInt32BE(0)
  if (algorithmLength === 0 || algorithmLength >= blob.length - 4 || blob.subarray(4, 4 + algorithmLength).toString("ascii") !== match[1]) {
    throw new Error("Public key algorithm does not match its key data")
  }
  return `${match[1]} ${match[2]}`
}

function runSshKeygen(args: string[]) {
  const result = spawnSync("ssh-keygen", args, { stdio: "ignore" })
  if (result.error || result.status !== 0) throw new Error("ssh-keygen failed; install OpenSSH client tools and retry")
}

async function writeSecret(filePath: string, contents: string, uid: number, gid: number) {
  await writeFile(filePath, contents, { flag: "wx", mode: 0o600 })
  await chmod(filePath, 0o600)
  if (typeof process.getuid === "function" && process.getuid() === 0) await chown(filePath, uid, gid)
}

async function readPrivateFile(filePath: string, uid: number, gid: number) {
  const info = await lstat(filePath)
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Private deployment credential must be a regular file")
  await chmod(filePath, 0o600)
  if (typeof process.getuid === "function" && process.getuid() === 0 && (info.uid !== uid || info.gid !== gid)) {
    await chown(filePath, uid, gid)
  }
  return readFile(filePath, "utf8")
}

async function ensureOwnedPrivateDir(dirPath: string, uid: number, gid: number) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 })
  await chmod(dirPath, 0o700)
  if (typeof process.getuid === "function" && process.getuid() === 0) await chown(dirPath, uid, gid)
}

export async function initializeRemoteWorkspace(options: InitRemoteWorkspaceOptions) {
  const hostnameMode = options.hostnameMode ?? "subdomain"
  if (hostnameMode !== "subdomain" && hostnameMode !== "shared") throw new Error("Invalid hostname mode")
  if (options.local && hostnameMode === "shared") throw new Error("Shared hostname mode cannot be combined with local mode")
  const publicHostname = hostnameMode === "shared" ? validateDomain(options.publicHostname ?? options.domain) : undefined
  const domain = options.local ? "localhost" : validateDomain(publicHostname ?? options.domain)
  validateAccounts(options.accounts)
  if (hostnameMode === "shared") {
    if (options.accounts.some((account) => account.webPort === undefined)) throw new Error("Shared hostname mode requires a distinct web port for every account")
    await validateSharedTls(options.tls)
  } else if (options.tls || options.publicHostname) {
    throw new Error("External hostname and TLS settings require shared hostname mode")
  }
  for (const account of options.accounts) {
    if (!options.publicKeys[account.name]) throw new Error(`A public key file is required for account ${account.name}`)
  }
  if (!Number.isInteger(options.runtimeUid) || options.runtimeUid < 1 || !Number.isInteger(options.runtimeGid) || options.runtimeGid < 1) {
    throw new Error("Runtime UID and GID must be non-root positive integers")
  }
  const finalOutputDir = path.resolve(options.outputDir)
  if (finalOutputDir === path.parse(finalOutputDir).root) throw new Error("Output directory cannot be the filesystem root")
  if (typeof process.getuid === "function" && process.getuid() !== 0 && process.getuid() !== options.runtimeUid) {
    throw new Error("Run init as the selected runtime UID, or use root to assign the output owner")
  }
  try {
    await stat(finalOutputDir)
    throw new Error("Deployment already exists; refusing to replace it")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await mkdir(path.dirname(finalOutputDir), { recursive: true })
  const stagingDir = `${finalOutputDir}.init-${randomBytes(8).toString("hex")}`
  await mkdir(stagingDir, { mode: 0o700 })
  try {
    const outputDir = stagingDir
    if (typeof process.getuid === "function" && process.getuid() === 0) await chown(outputDir, options.runtimeUid, options.runtimeGid)
    await chmod(outputDir, 0o700)
    const manifestPath = path.join(outputDir, MANIFEST_FILE)
    const manifest: RemoteWorkspaceManifest = {
      version: 1,
      domain,
      local: options.local === true,
      runtimeUid: options.runtimeUid,
      runtimeGid: options.runtimeGid,
      accounts: options.accounts,
      ...(hostnameMode === "shared" ? {
        hostnameMode,
        publicHostname,
        tls: options.tls,
      } : {}),
    }
    const secretsRoot = path.join(outputDir, "secrets")
    const stateRoot = path.join(outputDir, "state")
    await ensureOwnedPrivateDir(secretsRoot, options.runtimeUid, options.runtimeGid)
    await ensureOwnedPrivateDir(stateRoot, options.runtimeUid, options.runtimeGid)

    for (const account of options.accounts) {
      const accountSecrets = path.join(secretsRoot, account.name)
      const accountState = path.join(stateRoot, account.name)
      await ensureOwnedPrivateDir(accountSecrets, options.runtimeUid, options.runtimeGid)
      await ensureOwnedPrivateDir(accountState, options.runtimeUid, options.runtimeGid)
      for (const leaf of ["home", "codex", "workspace", "ssh-home"]) {
        await ensureOwnedPrivateDir(path.join(accountState, leaf), options.runtimeUid, options.runtimeGid)
      }

      await writeSecret(path.join(accountSecrets, "app-password"), `${randomBytes(32).toString("base64url")}\n`, options.runtimeUid, options.runtimeGid)
      const hostKey = path.join(accountState, "ssh-host-ed25519")
      runSshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", `kanna-host-${account.name}`, "-f", hostKey])
      await chmod(hostKey, 0o600)
      if (typeof process.getuid === "function" && process.getuid() === 0) {
        await chown(hostKey, options.runtimeUid, options.runtimeGid)
        await chown(`${hostKey}.pub`, options.runtimeUid, options.runtimeGid)
      }
      const importedKeyPath = options.publicKeys[account.name]!
      const imported = parseOpenSshPublicKey(await readFile(importedKeyPath, "utf8"))
      await writeSecret(path.join(accountSecrets, "authorized_keys"), `${imported}\n`, options.runtimeUid, options.runtimeGid)
      await ensureOwnedPrivateDir(path.join(accountSecrets, "ssh"), options.runtimeUid, options.runtimeGid)
      // The authorized key is mounted by the SSH sidecar; secrets never enter its image.
      const authorizedKeys = path.join(accountSecrets, "authorized_keys")
      await chmod(authorizedKeys, 0o600)
      if (typeof process.getuid === "function" && process.getuid() === 0) await chown(authorizedKeys, options.runtimeUid, options.runtimeGid)
    }

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await chmod(manifestPath, 0o600)
    if (typeof process.getuid === "function" && process.getuid() === 0) await chown(manifestPath, options.runtimeUid, options.runtimeGid)
    await writeFile(path.join(outputDir, ".env"), `REMOTE_UID=${options.runtimeUid}\nREMOTE_GID=${options.runtimeGid}\n`, { flag: "wx", mode: 0o600 })
    await chmod(path.join(outputDir, ".env"), 0o600)
    if (typeof process.getuid === "function" && process.getuid() === 0) await chown(path.join(outputDir, ".env"), options.runtimeUid, options.runtimeGid)
    await rename(stagingDir, finalOutputDir)
    return manifest
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true })
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EINVAL" || code === "EPERM" || code === "EACCES") {
      throw new Error(`Cannot prepare persistent state for UID ${options.runtimeUid} and GID ${options.runtimeGid}; run init as that account or use a host that permits ownership mapping`)
    }
    throw error
  }
}

function quoteYaml(value: string) {
  return JSON.stringify(value)
}

export function renderHostedWorkspaceConfig(manifest: RemoteWorkspaceManifest, account: RemoteWorkspaceAccount) {
  const shared = (manifest.hostnameMode ?? "subdomain") === "shared"
  const host = manifest.local ? "127.0.0.1" : shared ? manifest.publicHostname! : `${account.name}.${manifest.domain}`
  const config = {
    displayName: account.name,
    sshHost: host,
    sshPort: account.sshPort,
    sshUser: "workspace",
    workspaceRoot: "/workspace",
    publicHostKey: "",
  }
  if (!shared) return config
  const gatewayMode = manifest.gateway?.enabled === true
  const webPort = gatewayMode ? manifest.gateway!.publicPort : account.webPort!
  return {
    ...config,
    authMode: "bearer" as const,
    webHost: host,
    webPort,
    webOrigin: `${manifest.tls?.mode === "none" ? "http" : "https"}://${host}:${webPort}`,
  }
}

/** Enable the one-port gateway on an existing shared HTTP deployment. */
export async function enableRemoteWorkspaceGateway(outputDirInput: string, publicPort = 8444) {
  const outputDir = path.resolve(outputDirInput)
  const manifestPath = path.join(outputDir, MANIFEST_FILE)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RemoteWorkspaceManifest
  if (manifest.version !== 1 || validateManifestHostname(manifest) !== "shared" || manifest.tls?.mode !== "none" || manifest.local) {
    throw new Error("Gateway mode requires an existing shared-hostname HTTP deployment")
  }
  if (!Number.isInteger(publicPort) || publicPort < 1024 || publicPort > 65535 || manifest.accounts.some((account) => account.sshPort === publicPort)) {
    throw new Error("Gateway public port is invalid or conflicts with SSH")
  }
  if (typeof process.getuid === "function" && process.getuid() !== 0 && process.getuid() !== manifest.runtimeUid) {
    throw new Error(`Run enable-gateway as UID ${manifest.runtimeUid}, or use root to assign the output owner`)
  }
  const { GatewayStore } = await import("../src/server/gateway/gateway-store")
  const gatewayState = path.join(outputDir, "state", "gateway")
  const gatewayAdminHome = path.join(outputDir, "state", "gateway-admin-home")
  const gatewaySecrets = path.join(outputDir, "secrets")
  await ensureOwnedPrivateDir(gatewayState, manifest.runtimeUid, manifest.runtimeGid)
  await ensureOwnedPrivateDir(gatewayAdminHome, manifest.runtimeUid, manifest.runtimeGid)
  const store = new GatewayStore(gatewayState, { uid: manifest.runtimeUid, gid: manifest.runtimeGid })
  for (const account of manifest.accounts) {
    if (await store.findUser(account.name)) continue
    const passwordPath = path.join(gatewaySecrets, account.name, "app-password")
    const password = (await readPrivateFile(passwordPath, manifest.runtimeUid, manifest.runtimeGid)).trim()
    if (!password) throw new Error(`Existing workspace password is unavailable for ${account.name}`)
    await store.createUser({ username: account.name, password, role: "user", accountId: account.name })
  }
  if (!await store.findUser("admin")) {
    const adminPasswordPath = path.join(gatewaySecrets, "gateway-admin-password")
    let adminPassword: string
    try {
      adminPassword = (await readPrivateFile(adminPasswordPath, manifest.runtimeUid, manifest.runtimeGid)).trim()
      if (!adminPassword) throw new Error("Gateway administrator password file is empty")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      adminPassword = randomBytes(32).toString("base64url")
      await writeSecret(adminPasswordPath, `${adminPassword}\n`, manifest.runtimeUid, manifest.runtimeGid)
    }
    await store.createUser({ username: "admin", password: adminPassword, role: "admin" })
  }
  for (const account of manifest.accounts) {
    const tokenPath = path.join(gatewaySecrets, account.name, "gateway-account-token")
    let token: string
    try {
      token = (await readPrivateFile(tokenPath, manifest.runtimeUid, manifest.runtimeGid)).trim()
      if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) throw new Error(`Invalid gateway token file for ${account.name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      token = randomBytes(32).toString("base64url")
      await writeSecret(tokenPath, `${token}\n`, manifest.runtimeUid, manifest.runtimeGid)
    }
    const envPath = path.join(outputDir, "config", `${account.name}.gateway.env`)
    await mkdir(path.dirname(envPath), { recursive: true, mode: 0o755 })
    try {
      const envText = await readPrivateFile(envPath, manifest.runtimeUid, manifest.runtimeGid)
      const expected = `KANNA_GATEWAY_URL=http://gateway:3210\nKANNA_GATEWAY_ACCOUNT_TOKEN=${token}\n`
      if (envText !== expected) throw new Error(`Gateway account environment does not match its token for ${account.name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await writeSecret(envPath, `KANNA_GATEWAY_URL=http://gateway:3210\nKANNA_GATEWAY_ACCOUNT_TOKEN=${token}\n`, manifest.runtimeUid, manifest.runtimeGid)
    }
  }
  manifest.gateway = { enabled: true, publicPort }
  const temporaryManifest = `${manifestPath}.${randomBytes(8).toString("hex")}.tmp`
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  await chmod(temporaryManifest, 0o600)
  if (typeof process.getuid === "function" && process.getuid() === 0) await chown(temporaryManifest, manifest.runtimeUid, manifest.runtimeGid)
  await rename(temporaryManifest, manifestPath)
  return { manifest, adminPasswordPath: path.join(gatewaySecrets, "gateway-admin-password") }
}

export async function addRemoteWorkspaceAccount(args: {
  outputDir: string
  account: RemoteWorkspaceAccount
  publicKeyPath: string
}) {
  const outputDir = path.resolve(args.outputDir)
  const manifestPath = path.join(outputDir, MANIFEST_FILE)
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RemoteWorkspaceManifest
  if (manifest.version !== 1) throw new Error("Unsupported deployment manifest version")
  if (manifest.gateway?.enabled) throw new Error("Adding accounts after gateway mode is enabled is not supported yet")
  if (manifest.local) {
    if (manifest.domain !== "localhost") throw new Error("Local deployment domain must be localhost")
  } else {
    validateDomain(manifest.domain)
  }
  const hostnameMode = validateManifestHostname(manifest)
  if (hostnameMode === "shared") await validateSharedTls(manifest.tls)
  validateAccounts([...manifest.accounts, args.account])
  if (hostnameMode === "shared" && args.account.webPort === undefined) {
    throw new Error("Shared hostname mode requires a web port for every account")
  }
  const key = parseOpenSshPublicKey(await readFile(args.publicKeyPath, "utf8"))
  const secrets = path.join(outputDir, "secrets", args.account.name)
  const state = path.join(outputDir, "state", args.account.name)
  const suffix = randomBytes(8).toString("hex")
  const stagingSecrets = path.join(outputDir, "secrets", `.${args.account.name}.init-${suffix}`)
  const stagingState = path.join(outputDir, "state", `.${args.account.name}.init-${suffix}`)
  const temporaryManifest = `${manifestPath}.${suffix}.tmp`
  let movedSecrets = false
  let movedState = false
  try {
    try {
      await stat(secrets)
      throw new Error(`Account state already exists for ${args.account.name}; refusing to replace it`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    try {
      await stat(state)
      throw new Error(`Account state already exists for ${args.account.name}; refusing to replace it`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await ensureOwnedPrivateDir(stagingSecrets, manifest.runtimeUid, manifest.runtimeGid)
    await ensureOwnedPrivateDir(stagingState, manifest.runtimeUid, manifest.runtimeGid)
    for (const leaf of ["home", "codex", "workspace", "ssh-home"]) {
      await ensureOwnedPrivateDir(path.join(stagingState, leaf), manifest.runtimeUid, manifest.runtimeGid)
    }
    const hostKey = path.join(stagingState, "ssh-host-ed25519")
    runSshKeygen(["-q", "-t", "ed25519", "-N", "", "-C", `kanna-host-${args.account.name}`, "-f", hostKey])
    await chmod(hostKey, 0o600)
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await chown(hostKey, manifest.runtimeUid, manifest.runtimeGid)
      await chown(`${hostKey}.pub`, manifest.runtimeUid, manifest.runtimeGid)
    }
    await writeSecret(path.join(stagingSecrets, "authorized_keys"), `${key}\n`, manifest.runtimeUid, manifest.runtimeGid)
    await writeSecret(path.join(stagingSecrets, "app-password"), `${randomBytes(32).toString("base64url")}\n`, manifest.runtimeUid, manifest.runtimeGid)
    await rename(stagingState, state)
    movedState = true
    await rename(stagingSecrets, secrets)
    movedSecrets = true
    manifest.accounts.push(args.account)
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await chmod(temporaryManifest, 0o600)
    if (typeof process.getuid === "function" && process.getuid() === 0) await chown(temporaryManifest, manifest.runtimeUid, manifest.runtimeGid)
    await rename(temporaryManifest, manifestPath)
    return manifest
  } catch (error) {
    await rm(stagingSecrets, { recursive: true, force: true })
    await rm(stagingState, { recursive: true, force: true })
    await rm(temporaryManifest, { force: true })
    if (movedSecrets) await rm(secrets, { recursive: true, force: true })
    if (movedState) await rm(state, { recursive: true, force: true })
    const code = (error as NodeJS.ErrnoException).code
    if (code === "EINVAL" || code === "EPERM" || code === "EACCES") {
      throw new Error(`Cannot prepare persistent state for UID ${manifest.runtimeUid} and GID ${manifest.runtimeGid}; run add-account as that account or use a host that permits ownership mapping`)
    }
    throw error
  }
}

export async function generateRemoteWorkspaceFiles(outputDirInput: string) {
  const outputDir = path.resolve(outputDirInput)
  const repositoryContext = path.relative(outputDir, REPOSITORY_ROOT).split(path.sep).join("/") || "."
  const manifest = JSON.parse(await readFile(path.join(outputDir, MANIFEST_FILE), "utf8")) as RemoteWorkspaceManifest
  if (manifest.version !== 1) throw new Error("Unsupported deployment manifest version")
  if (manifest.local) {
    if (manifest.domain !== "localhost") throw new Error("Local deployment domain must be localhost")
  } else {
    validateDomain(manifest.domain)
  }
  const hostnameMode = validateManifestHostname(manifest)
  const sharedHostname = hostnameMode === "shared"
  const gatewayMode = manifest.gateway?.enabled === true
  if (sharedHostname) await validateSharedTls(manifest.tls)
  validateAccounts(manifest.accounts)
  const hostKeyByAccount = new Map<string, string>()
  for (const account of manifest.accounts) {
    const publicKey = parseOpenSshPublicKey(await readFile(path.join(outputDir, "state", account.name, "ssh-host-ed25519.pub"), "utf8"))
    hostKeyByAccount.set(account.name, publicKey)
    const config = { ...renderHostedWorkspaceConfig(manifest, account), publicHostKey: publicKey }
    const configDir = path.join(outputDir, "config")
    await mkdir(configDir, { recursive: true, mode: 0o755 })
    await chmod(configDir, 0o755)
    await writeFile(path.join(configDir, `${account.name}.json`), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 })
    const knownHost = config.sshHost
    await writeFile(path.join(configDir, `${account.name}.known_hosts`), `[${knownHost}]:${account.sshPort} ${publicKey}\n`, { mode: 0o644 })
    await chmod(path.join(configDir, `${account.name}.known_hosts`), 0o644)
    if (gatewayMode) {
      const envPath = path.join(configDir, `${account.name}.gateway.env`)
      const values = (await readFile(envPath, "utf8")).split(/\r?\n/).filter(Boolean)
      if (values.length !== 2 || values[0] !== "KANNA_GATEWAY_URL=http://gateway:3210" || !/^KANNA_GATEWAY_ACCOUNT_TOKEN=[A-Za-z0-9_-]{32,128}$/.test(values[1]!)) {
        throw new Error(`Invalid private gateway environment file for ${account.name}`)
      }
      await chmod(envPath, 0o600)
    }
  }

  const networks = manifest.accounts.map((account) => `account_${account.name}`)
  const caddyNetworks = networks.map((network) => `      - ${network}`).join("\n")
  const localPorts = manifest.local
    ? `      - "127.0.0.1:8080:80"\n      - "127.0.0.1:8443:443"`
    : `      - "80:80"\n      - "443:443"`
  const caddyPorts = sharedHostname
    ? manifest.accounts.map((account) => `      - ${quoteYaml(`${account.webPort}:${account.webPort}`)}`).join("\n")
    : localPorts
  const services: string[] = []
  for (const account of manifest.accounts) {
    const network = `account_${account.name}`
    const state = `./state/${account.name}`
    const secrets = `./secrets/${account.name}`
    const app = `kanna_${account.name}`
    const ssh = `ssh_${account.name}`
    const sshPort = manifest.local ? `127.0.0.1:${account.sshPort}:2222` : `${account.sshPort}:2222`
    services.push(`  ${app}:
    build:
      context: ${quoteYaml(repositoryContext)}
      dockerfile: deploy/remote-workspace/Dockerfile.app
      args:
        REMOTE_UID: "\${REMOTE_UID}"
        REMOTE_GID: "\${REMOTE_GID}"
    image: kanna-remote-app:0.82.0
    init: true
    user: "\${REMOTE_UID}:\${REMOTE_GID}"
    command: ["--host", "0.0.0.0", "--no-open", "--password-file", "/run/secrets/kanna_password", "--trust-proxy"]
    environment:
      HOME: /home/kanna
      CODEX_HOME: /home/kanna/.codex
      KANNA_TRUST_PROXY: "1"
      KANNA_HOSTED_WORKSPACE_CONFIG: /run/hosted-workspace.json${gatewayMode ? `
      KANNA_GATEWAY_URL: http://gateway:3210` : ""}
    ${gatewayMode ? `env_file:
      - ./config/${account.name}.gateway.env` : ""}
    volumes:
      - ${state}/home:/home/kanna
      - ${state}/codex:/home/kanna/.codex
      - ${state}/workspace:/workspace
      - ./config/${account.name}.json:/run/hosted-workspace.json:ro
      - ${secrets}/app-password:/run/secrets/kanna_password:ro
    expose:
      - "3210"
    networks:
      - ${network}
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=128m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    cpus: 2.0
    mem_limit: 2g
    restart: unless-stopped`)
  services.push(`  ${ssh}:
    build:
      context: ${quoteYaml(path.relative(outputDir, path.join(REPOSITORY_ROOT, "deploy/remote-workspace")).split(path.sep).join("/"))}
      dockerfile: Dockerfile.ssh
      args:
        REMOTE_UID: "\${REMOTE_UID}"
        REMOTE_GID: "\${REMOTE_GID}"
    image: kanna-remote-ssh:0.82.0
    user: "0:0"
    ports:
      - ${quoteYaml(sshPort)}
    volumes:
      - ${state}/workspace:/workspace
      - ${state}/ssh-home:/home/workspace
      - ${state}/ssh-host-ed25519:/etc/ssh/hostkeys/ssh_host_ed25519_key:ro
      - ${state}/ssh-host-ed25519.pub:/etc/ssh/hostkeys/ssh_host_ed25519_key.pub:ro
      - ${secrets}/authorized_keys:/run/authorized_keys:ro
    networks:
      - ${network}
    read_only: true
    tmpfs:
      - /run/sshd:rw,noexec,nosuid,size=1m
      - /tmp:rw,noexec,nosuid,size=64m
    cap_drop:
      - ALL
    cap_add:
      - SETUID
      - SETGID
      - SYS_CHROOT
      - DAC_READ_SEARCH
    security_opt:
      - no-new-privileges:true
    pids_limit: 128
    cpus: 0.5
    mem_limit: 256m
    restart: unless-stopped`)
  }
  const accountNetworks = manifest.accounts.map((account) => `  account_${account.name}:\n    driver: bridge`).join("\n")
  const caddyTlsVolumes = sharedHostname && manifest.tls?.mode === "external"
    ? `\n      - type: bind\n        source: ${quoteYaml(await realpath(manifest.tls!.certFile))}\n        target: /run/caddy/external-cert.pem\n        read_only: true\n      - type: bind\n        source: ${quoteYaml(await realpath(manifest.tls!.keyFile))}\n        target: /run/caddy/external-key.pem\n        read_only: true`
    : ""
  const caddyBlock = gatewayMode ? "" : `  caddy:
    image: caddy:2.10.2-alpine
    ports:
${caddyPorts}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config${caddyTlsVolumes}
    networks:
${caddyNetworks}
    restart: unless-stopped`
  let gatewayBlock = ""
  if (gatewayMode) {
    const gatewayConfig = {
      publicOrigin: `http://${manifest.publicHostname}:${manifest.gateway!.publicPort}`,
      stateDirectory: "/var/lib/kanna-gateway/state",
      adminHomeDirectory: "/var/lib/kanna-gateway/admin-home",
      clientDirectory: "/app/dist/client",
      accounts: manifest.accounts.map((account) => ({
        id: account.name,
        appUrl: `http://kanna_${account.name}:3210`,
        appPasswordFile: `/run/gateway-secrets/${account.name}/app-password`,
        accountTokenFile: `/run/gateway-secrets/${account.name}/gateway-account-token`,
      })),
    }
    await writeFile(path.join(outputDir, "config", "gateway.json"), `${JSON.stringify(gatewayConfig, null, 2)}\n`, { mode: 0o644 })
    gatewayBlock = `  gateway:
    build:
      context: ${quoteYaml(repositoryContext)}
      dockerfile: deploy/remote-workspace/Dockerfile.app
      args:
        REMOTE_UID: "\${REMOTE_UID}"
        REMOTE_GID: "\${REMOTE_GID}"
    image: kanna-remote-app:0.82.0
    init: true
    user: "\${REMOTE_UID}:\${REMOTE_GID}"
    command: ["--no-open"]
    environment:
      KANNA_GATEWAY_MODE: "1"
      KANNA_GATEWAY_CONFIG: /run/gateway-config.json
      HOME: /var/lib/kanna-gateway/admin-home
      BUN_INSTALL: /var/lib/kanna-gateway/admin-home/.bun
      PATH: /var/lib/kanna-gateway/admin-home/.bun/bin:/opt/bun/bin:/usr/local/sbin:/usr/sbin:/sbin:/usr/local/bin:/usr/bin:/bin:/usr/local/bun-node-fallback-bin
    ports:
      - ${quoteYaml(`${manifest.gateway!.publicPort}:3210`)}
    volumes:
      - ./config/gateway.json:/run/gateway-config.json:ro
      - ./state/gateway:/var/lib/kanna-gateway/state
      - ./state/gateway-admin-home:/var/lib/kanna-gateway/admin-home
${manifest.accounts.map((account) => `      - ./secrets/${account.name}/app-password:/run/gateway-secrets/${account.name}/app-password:ro\n      - ./secrets/${account.name}/gateway-account-token:/run/gateway-secrets/${account.name}/gateway-account-token:ro`).join("\n")}
    networks:
${caddyNetworks}
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,size=128m
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    pids_limit: 256
    cpus: 1.0
    mem_limit: 1g
    restart: unless-stopped`
  }
  const compose = `name: kanna-remote-workspace
services:
${caddyBlock}${gatewayBlock ? `\n${gatewayBlock}` : ""}
${services.join("\n\n")}

${gatewayMode ? "" : `volumes:\n  caddy_data:\n  caddy_config:\n`}

networks:
${accountNetworks}
`
  const caddyfile = gatewayMode ? "" : manifest.accounts.map((account) => {
    if (sharedHostname) {
      const address = manifest.tls?.mode === "none" ? `http://${manifest.publicHostname}:${account.webPort}` : `${manifest.publicHostname}:${account.webPort}`
      const tlsDirective = manifest.tls?.mode === "internal"
        ? "  tls internal\n"
        : manifest.tls?.mode === "external"
          ? "  tls /run/caddy/external-cert.pem /run/caddy/external-key.pem\n"
          : ""
      return `${address} {\n${tlsDirective}  reverse_proxy http://kanna_${account.name}:3210 {\n    header_up -Cookie\n    header_down -Set-Cookie\n  }\n}`
    }
    const site = manifest.local ? `${account.name}.localhost` : `${account.name}.${manifest.domain}`
    return `${site} {\n${manifest.local ? "  tls internal\n" : ""}  reverse_proxy http://kanna_${account.name}:3210\n}`
  }).join("\n\n") + "\n"

  await writeFile(path.join(outputDir, "compose.yaml"), compose, { mode: 0o600 })
  if (caddyfile) await writeFile(path.join(outputDir, "Caddyfile"), caddyfile, { mode: 0o600 })
  await copyFile(new URL("../deploy/remote-workspace/sync.sh", import.meta.url), path.join(outputDir, "sync.sh"))
  await chmod(path.join(outputDir, "compose.yaml"), 0o644)
  if (caddyfile) await chmod(path.join(outputDir, "Caddyfile"), 0o644)
  await chmod(path.join(outputDir, "sync.sh"), 0o755)
  return { manifest, compose, caddyfile, hostKeyByAccount }
}
