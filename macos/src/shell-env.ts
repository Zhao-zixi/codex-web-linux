import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export type Env = Record<string, string>

/**
 * The user's login-shell environment. An app opened from Finder (or at
 * login) gets launchd's bare one, without the PATH that finds `kanna`,
 * `bun`, `claude` and `codex`, or the variables agents read, like
 * ANTHROPIC_API_KEY, HTTPS_PROXY and cloud credentials. So the app asks an
 * interactive login shell once and hands everything to the server, as if it
 * had been started from a terminal.
 */
let cached: Promise<Env> | null = null

/** Where installers put things; searched even when the shell's PATH misses them. */
function fallbackDirectories() {
  const home = os.homedir()
  return [`${home}/.bun/bin`, `${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin"]
}

export function shellEnv() {
  cached ??= load()
  return cached
}

/** After an install that edited the shell profile. */
export function reloadShellEnv() {
  cached = null
}

export function which(command: string, env: Env) {
  const dirs = (env.PATH ?? "").split(":").filter(Boolean).concat(fallbackDirectories())
  for (const dir of dirs) {
    const candidate = path.join(dir, command)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {}
  }
  return null
}

const MARKER = "__KANNA_SHELL_ENV__"
const SKIPPED = new Set(["PWD", "OLDPWD", "SHLVL", "_", "DISABLE_AUTO_UPDATE"])

async function load(): Promise<Env> {
  const env: Env = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // Electron's own switches must not reach the server or the tools it runs.
  for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_")) delete env[key]

  const output = await new Promise<Buffer>((resolve) => {
    const chunks: Buffer[] = []
    let child
    try {
      child = spawn(env.SHELL ?? "/bin/zsh", ["-ilc", `printf '%s' ${MARKER}; /usr/bin/env -0`], {
        // oh-my-zsh otherwise asks whether to update, and nobody can answer.
        env: { ...env, DISABLE_AUTO_UPDATE: "true" },
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      resolve(Buffer.alloc(0))
      return
    }
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    // A profile that waits on something (a prompt, a slow plugin) must not
    // keep Kanna from starting.
    const timer = setTimeout(() => child.kill(), 5_000)
    child.on("error", () => {})
    child.on("close", () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
  })

  const start = output.indexOf(MARKER)
  if (start >= 0) {
    for (const entry of output.subarray(start + MARKER.length).toString("utf8").split("\0")) {
      const equals = entry.indexOf("=")
      if (equals <= 0) continue
      const key = entry.slice(0, equals)
      if (!SKIPPED.has(key)) env[key] = entry.slice(equals + 1)
    }
  }

  const pathEntries = (env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(":")
  for (const dir of fallbackDirectories()) if (!pathEntries.includes(dir)) pathEntries.push(dir)
  env.PATH = pathEntries.join(":")
  return env
}
