import { randomBytes } from "node:crypto"
import { chmod, chown, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export interface RemoteWorkspaceAccount {
  name: string
  sshPort: number
}

export interface RemoteWorkspaceManifest {
  version: 1
  domain: string
  local: boolean
  runtimeUid: number
  runtimeGid: number
  accounts: RemoteWorkspaceAccount[]
}

export interface InitRemoteWorkspaceOptions {
  outputDir: string
  domain: string
  accounts: RemoteWorkspaceAccount[]
  local?: boolean
  runtimeUid: number
  runtimeGid: number
  publicKeys: Record<string, string>
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
  for (const account of accounts) {
    validateAccountName(account.name)
    if (names.has(account.name)) throw new Error(`Duplicate account: ${account.name}`)
    names.add(account.name)
    if (!Number.isInteger(account.sshPort) || account.sshPort < 1024 || account.sshPort > 65535) throw new Error(`Invalid SSH port for ${account.name}`)
    if (ports.has(account.sshPort)) throw new Error(`Duplicate SSH port: ${account.sshPort}`)
    ports.add(account.sshPort)
  }
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

async function ensureOwnedPrivateDir(dirPath: string, uid: number, gid: number) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 })
  await chmod(dirPath, 0o700)
  if (typeof process.getuid === "function" && process.getuid() === 0) await chown(dirPath, uid, gid)
}

export async function initializeRemoteWorkspace(options: InitRemoteWorkspaceOptions) {
  const domain = options.local ? "localhost" : validateDomain(options.domain)
  validateAccounts(options.accounts)
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
  const host = manifest.local ? "127.0.0.1" : `${account.name}.${manifest.domain}`
  return {
    displayName: account.name,
    sshHost: host,
    sshPort: account.sshPort,
    sshUser: "workspace",
    workspaceRoot: "/workspace",
    publicHostKey: "",
  }
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
  if (manifest.local) {
    if (manifest.domain !== "localhost") throw new Error("Local deployment domain must be localhost")
  } else {
    validateDomain(manifest.domain)
  }
  validateAccounts([...manifest.accounts, args.account])
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
  }

  const networks = manifest.accounts.map((account) => `account_${account.name}`)
  const caddyNetworks = networks.map((network) => `      - ${network}`).join("\n")
  const localPorts = manifest.local
    ? `      - "127.0.0.1:8080:80"\n      - "127.0.0.1:8443:443"`
    : `      - "80:80"\n      - "443:443"`
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
      KANNA_HOSTED_WORKSPACE_CONFIG: /run/hosted-workspace.json
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
  const caddyBlock = `  caddy:
    image: caddy:2.10.2-alpine
    ports:
${localPorts}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    networks:
${caddyNetworks}
    restart: unless-stopped`
  const compose = `name: kanna-remote-workspace
services:
${caddyBlock}
${services.join("\n\n")}

volumes:
  caddy_data:
  caddy_config:

networks:
${accountNetworks}
`
  const caddyfile = manifest.accounts.map((account) => {
    const site = manifest.local ? `${account.name}.localhost` : `${account.name}.${manifest.domain}`
    return `${site} {\n${manifest.local ? "  tls internal\n" : ""}  reverse_proxy http://kanna_${account.name}:3210\n}`
  }).join("\n\n") + "\n"

  await writeFile(path.join(outputDir, "compose.yaml"), compose, { mode: 0o600 })
  await writeFile(path.join(outputDir, "Caddyfile"), caddyfile, { mode: 0o600 })
  await copyFile(new URL("../deploy/remote-workspace/sync.sh", import.meta.url), path.join(outputDir, "sync.sh"))
  await chmod(path.join(outputDir, "compose.yaml"), 0o644)
  await chmod(path.join(outputDir, "Caddyfile"), 0o644)
  await chmod(path.join(outputDir, "sync.sh"), 0o755)
  return { manifest, compose, caddyfile, hostKeyByAccount }
}
