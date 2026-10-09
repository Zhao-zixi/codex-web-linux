#!/usr/bin/env bun
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { X509Certificate } from "node:crypto"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  addRemoteWorkspaceAccount,
  generateRemoteWorkspaceFiles,
  initializeRemoteWorkspace,
  validateAccountName,
  validateDomain,
} from "./remote-workspace-lib"

const DEFAULT_OUTPUT = ".remote-workspace"

function usage() {
  console.log(`Remote Kanna workspace deployment

Commands:
  init --account name:ssh-port[:https-port] --pubkey name=/path/key.pub [options]
  generate [--output directory]
  up [--output directory]
  doctor [--output directory]
  export-ca [--output directory] [--output-file file]
  add-account --account name:ssh-port[:https-port] --pubkey /path/key.pub [--output directory]

Options:
  --output directory  Deployment state directory (default ${DEFAULT_OUTPUT})
  --domain name       Public base domain with DNS for each <account>.<domain>
  --hostname-mode     shared to use one hostname and a distinct HTTPS port per account
  --public-hostname   Hostname used by shared mode (for example fnos.example.com)
  --tls-cert-file     Absolute path to an external PEM certificate chain
  --tls-key-file      Absolute path to an external PEM private key (mode 0600)
  --tls-mode          shared hostname TLS mode: external (default) or internal
  --output-file       Public CA export destination (default ./fnos-root-ca.crt)
  --local             Bind HTTPS and SSH to loopback for local testing
  --uid number        Container account UID (default 1000)
  --gid number        Container account GID (default 1000)
  --account name:ssh-port[:https-port] Add an account; repeat for init
  --pubkey name=path  OpenSSH public key per account; required for init
`)
}

function parseOptions(args: string[]) {
  const options: Record<string, string | string[] | boolean> = {}
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg === "--local") {
      options.local = true
      continue
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`)
    const value = args[index + 1]
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`)
    index += 1
    const key = arg.slice(2)
    const previous = options[key]
    if (previous === undefined) options[key] = value
    else if (typeof previous === "string") options[key] = [previous, value]
    else if (Array.isArray(previous)) options[key] = [...previous, value]
    else throw new Error(`Option ${arg} cannot be combined with another value`)
  }
  return options
}

function values(options: Record<string, string | string[] | boolean>, name: string): string[] {
  const value = options[name]
  if (value === undefined) return []
  return Array.isArray(value) ? value : [String(value)]
}

function single(options: Record<string, string | string[] | boolean>, name: string, fallback?: string) {
  const all = values(options, name)
  if (all.length > 1) throw new Error(`Use ${name} only once`)
  return all[0] ?? fallback
}

function parseAccount(value: string) {
  const parts = value.split(":")
  if (parts.length < 2 || parts.length > 3 || !parts[0]) throw new Error(`Account must be name:ssh-port[:https-port]: ${value}`)
  return {
    name: validateAccountName(parts[0]!),
    sshPort: Number(parts[1]),
    ...(parts[2] === undefined ? {} : { webPort: Number(parts[2]) }),
  }
}

function parseNamedPublicKey(value: string) {
  const separator = value.indexOf("=")
  if (separator < 1 || separator === value.length - 1) throw new Error("Public key must be name=/path/to/key.pub")
  return [validateAccountName(value.slice(0, separator)), value.slice(separator + 1)] as const
}

function run(command: string, args: string[], options: { cwd?: string; quiet?: boolean } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.quiet ? "ignore" : "inherit",
    env: process.env,
  })
  if (result.error) throw new Error(`${command} is unavailable: ${result.error.message}`)
  return result.status ?? 1
}

function available(command: string) {
  const result = spawnSync(command, [], { stdio: "ignore", env: process.env })
  return !result.error
}

function withOutputDir(output: string, action: () => void) {
  const outputDir = path.resolve(output)
  if (!existsSync(path.join(outputDir, "compose.yaml"))) throw new Error(`No generated deployment at ${outputDir}; run generate first`)
  action()
}

const [command, ...args] = process.argv.slice(2)
try {
  if (!command || command === "--help" || command === "-h" || command === "help") {
    usage()
    process.exit(command ? 0 : 2)
  }
  const options = parseOptions(args)
  const output = path.resolve(single(options, "output", DEFAULT_OUTPUT)!)

  if (command === "init") {
    const accounts = values(options, "account").map(parseAccount)
    const publicKeys: Record<string, string> = {}
    for (const named of values(options, "pubkey")) {
      const [name, filePath] = parseNamedPublicKey(named)
      if (publicKeys[name]) throw new Error(`Duplicate public key for ${name}`)
      publicKeys[name] = filePath
    }
    const local = options.local === true
    const hostnameMode = single(options, "hostname-mode", "subdomain")!
    if (hostnameMode !== "shared" && hostnameMode !== "subdomain") throw new Error("--hostname-mode must be shared or subdomain")
    const publicHostnameOption = single(options, "public-hostname")
    const tlsCertFile = single(options, "tls-cert-file")
    const tlsKeyFile = single(options, "tls-key-file")
    if (hostnameMode !== "shared" && (values(options, "tls-mode").length > 0 || tlsCertFile || tlsKeyFile)) {
      throw new Error("TLS mode and external certificate flags require --hostname-mode shared")
    }
    const tlsMode = single(options, "tls-mode", "external")!
    if (tlsMode !== "external" && tlsMode !== "internal") throw new Error("--tls-mode must be external or internal")
    if (tlsMode === "internal" && (tlsCertFile || tlsKeyFile)) throw new Error("--tls-mode internal cannot be combined with --tls-cert-file or --tls-key-file")
    const tls = tlsMode === "internal"
      ? { mode: "internal" as const }
      : tlsCertFile || tlsKeyFile
        ? { mode: "external" as const, certFile: tlsCertFile ?? "", keyFile: tlsKeyFile ?? "" }
        : undefined
    const domain = local ? "localhost" : validateDomain(hostnameMode === "shared" ? publicHostnameOption ?? single(options, "domain") ?? "" : single(options, "domain") ?? "")
    const callerUid = typeof process.getuid === "function" ? process.getuid() : 1000
    const callerGid = typeof process.getgid === "function" ? process.getgid() : 1000
    const runtimeUid = Number(single(options, "uid", String(callerUid || 1000)))
    const runtimeGid = Number(single(options, "gid", String(callerGid || 1000)))
    await initializeRemoteWorkspace({
      outputDir: output,
      domain,
      local,
      accounts,
      publicKeys,
      runtimeUid,
      runtimeGid,
      hostnameMode,
      ...(hostnameMode === "shared" ? { publicHostname: domain, tls } : {}),
    })
    console.log(`Initialized private deployment state in ${output}`)
    console.log("Next: bun run remote-workspace -- generate")
  } else if (command === "generate") {
    const generated = await generateRemoteWorkspaceFiles(output)
    console.log(`Generated Compose, Caddy, account configs and known_hosts in ${output}`)
    console.log(`Configured ${generated.manifest.accounts.length} isolated account${generated.manifest.accounts.length === 1 ? "" : "s"}`)
  } else if (command === "up") {
    let status = 1
    withOutputDir(output, () => {
      status = run("docker", ["compose", "-f", path.join(output, "compose.yaml"), "up", "-d", "--build"])
    })
    process.exit(status)
  } else if (command === "export-ca") {
    withOutputDir(output, () => {})
    const manifest = JSON.parse(await Bun.file(path.join(output, "manifest.json")).text()) as { hostnameMode?: string; tls?: { mode?: string } }
    if (manifest.hostnameMode !== "shared" || manifest.tls?.mode !== "internal") {
      throw new Error("Public CA export is available only for shared mode with explicit internal TLS")
    }
    const destination = path.resolve(single(options, "output-file", "./fnos-root-ca.crt")!)
    if (existsSync(destination)) throw new Error("Refusing to overwrite the public CA destination")
    run("docker", ["compose", "-f", path.join(output, "compose.yaml"), "cp", "caddy:/data/caddy/pki/authorities/local/root.crt", destination], { cwd: output })
    try {
      chmodSync(destination, 0o644)
      const certificate = new X509Certificate(readFileSync(destination))
      if (!certificate.ca) throw new Error("Exported certificate is not a CA certificate")
      console.log(`Public CA saved to ${destination}`)
      console.log(`SHA-256 fingerprint: ${certificate.fingerprint256}`)
    } catch (error) {
      rmSync(destination, { force: true })
      throw error
    }
  } else if (command === "doctor") {
    let failed = false
    const check = (label: string, executable: string, args: string[]) => {
      const status = run(executable, args, { quiet: true })
      console.log(`${status === 0 ? "ok" : "missing"} ${label}`)
      if (status !== 0) failed = true
    }
    check("Docker daemon access", "docker", ["info"])
    check("Docker Compose v2", "docker", ["compose", "version"])
    const sshKeygenAvailable = available("ssh-keygen")
    console.log(`${sshKeygenAvailable ? "ok" : "missing"} OpenSSH key tools`)
    if (!sshKeygenAvailable) failed = true
    check("Mutagen", "mutagen", ["version"])
    check("jq for sync helper", "jq", ["--version"])
    if (existsSync(path.join(output, "manifest.json"))) {
      const manifest = JSON.parse(await Bun.file(path.join(output, "manifest.json")).text()) as {
        runtimeUid: number
        runtimeGid: number
        accounts: Array<{ name: string }>
      }
      const checkPath = (label: string, filePath: string, expectedType: "dir" | "file", privateMode: boolean, writable: boolean) => {
        try {
          const info = statSync(filePath)
          const mode = info.mode & 0o777
          const correctType = expectedType === "dir" ? info.isDirectory() : info.isFile()
          const correctOwner = info.uid === manifest.runtimeUid && info.gid === manifest.runtimeGid
          const privateEnough = !privateMode || (mode & 0o077) === 0
          const writableEnough = !writable || (expectedType === "dir" ? (mode & 0o300) === 0o300 : (mode & 0o200) !== 0)
          const ok = correctType && correctOwner && privateEnough && writableEnough
          console.log(`${ok ? "ok" : "unsafe"} ${label}${ok ? "" : ` (uid ${info.uid}, gid ${info.gid}, mode ${mode.toString(8)})`}`)
          if (!ok) failed = true
        } catch {
          console.log(`missing ${label}`)
          failed = true
        }
      }
      checkPath("private deployment directory", output, "dir", true, false)
      checkPath("deployment manifest", path.join(output, "manifest.json"), "file", true, false)
      checkPath("deployment environment file", path.join(output, ".env"), "file", true, false)
      checkPath("secrets directory", path.join(output, "secrets"), "dir", true, false)
      checkPath("persistent state directory", path.join(output, "state"), "dir", true, false)
      for (const account of manifest.accounts) {
        const secrets = path.join(output, "secrets", account.name)
        const state = path.join(output, "state", account.name)
        checkPath(`${account.name} secret directory`, secrets, "dir", true, false)
        checkPath(`${account.name} password file`, path.join(secrets, "app-password"), "file", true, false)
        checkPath(`${account.name} authorized keys`, path.join(secrets, "authorized_keys"), "file", true, false)
        checkPath(`${account.name} state directory`, state, "dir", true, false)
        for (const leaf of ["home", "codex", "workspace", "ssh-home"]) {
          checkPath(`${account.name} ${leaf} persistent directory`, path.join(state, leaf), "dir", true, true)
        }
        checkPath(`${account.name} SSH host key`, path.join(state, "ssh-host-ed25519"), "file", true, false)
      }
    } else {
      console.log(`info deployment not initialized at ${output}`)
    }
    process.exit(failed ? 1 : 0)
  } else if (command === "add-account") {
    const accountValues = values(options, "account")
    const keyValues = values(options, "pubkey")
    if (accountValues.length !== 1 || keyValues.length !== 1) throw new Error("add-account requires one --account name:port and one --pubkey /path/key.pub")
    const pubkey = keyValues[0]!.includes("=") ? parseNamedPublicKey(keyValues[0]!)[1] : keyValues[0]!
    const manifest = await addRemoteWorkspaceAccount({ outputDir: output, account: parseAccount(accountValues[0]!), publicKeyPath: pubkey })
    console.log(`Added ${manifest.accounts.at(-1)!.name}. Run generate, then up to apply the account.`)
  } else {
    throw new Error(`Unknown command: ${command}`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
