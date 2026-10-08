#!/usr/bin/env bun
import { existsSync, statSync } from "node:fs"
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
  init --account name:port --pubkey name=/path/key.pub [options]
  generate [--output directory]
  up [--output directory]
  doctor [--output directory]
  add-account --account name:port --pubkey /path/key.pub [--output directory]

Options:
  --output directory  Deployment state directory (default ${DEFAULT_OUTPUT})
  --domain name       Public base domain with DNS for each <account>.<domain>
  --local             Bind HTTPS and SSH to loopback for local testing
  --uid number        Container account UID (default 1000)
  --gid number        Container account GID (default 1000)
  --account name:port Add an account; repeat for init
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
  const separator = value.lastIndexOf(":")
  if (separator < 1) throw new Error(`Account must be name:port: ${value}`)
  return { name: validateAccountName(value.slice(0, separator)), sshPort: Number(value.slice(separator + 1)) }
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
    const domain = local ? "localhost" : validateDomain(single(options, "domain") ?? "")
    const callerUid = typeof process.getuid === "function" ? process.getuid() : 1000
    const callerGid = typeof process.getgid === "function" ? process.getgid() : 1000
    const runtimeUid = Number(single(options, "uid", String(callerUid || 1000)))
    const runtimeGid = Number(single(options, "gid", String(callerGid || 1000)))
    await initializeRemoteWorkspace({ outputDir: output, domain, local, accounts, publicKeys, runtimeUid, runtimeGid })
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
