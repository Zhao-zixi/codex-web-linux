import { spawn, spawnSync } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"

function formatSpawnError(command: string, error: unknown) {
  if (!(error instanceof Error)) {
    return new Error(`Failed to start ${command}`)
  }

  const code = "code" in error ? (error as NodeJS.ErrnoException).code : undefined
  if (code === "ENOENT") {
    return new Error(`Command not found: ${command}`)
  }

  return new Error(error.message || `Failed to start ${command}`)
}

export function spawnDetached(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore", detached: true })
    } catch (error) {
      reject(formatSpawnError(command, error))
      return
    }

    const handleError = (error: Error) => {
      reject(formatSpawnError(command, error))
    }

    child.once("error", handleError)
    child.once("spawn", () => {
      child.off("error", handleError)
      child.unref()
      resolve()
    })
  })
}

export function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

function succeedsAsync(command: string, args: string[]) {
  return new Promise<boolean>((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: "ignore" })
    } catch {
      resolve(false)
      return
    }
    child.once("error", () => resolve(false))
    child.once("close", (code) => resolve(code === 0))
  })
}

/**
 * `hasCommand` without blocking the event loop — for probes run in bulk.
 *
 * Windows has no `sh`, so asking it there would report every command missing
 * and quietly grey out the whole menu; `where` is the equivalent lookup.
 */
export function commandExists(command: string) {
  if (process.platform === "win32") {
    return succeedsAsync("where", [command])
  }
  return succeedsAsync("sh", ["-lc", `command -v ${command}`])
}

/** `canOpenMacApp` without blocking the event loop. */
export function macAppExists(appName: string) {
  return succeedsAsync("open", ["-Ra", appName])
}

/**
 * Per-user bin dirs installers target without necessarily reaching the
 * sh login PATH: the native Claude Code installer uses ~/.local/bin but adds
 * its PATH line to the interactive shell rc (~/.zshrc on macOS), which
 * `sh -lc` never reads. Checked as a fallback when the login shell misses.
 */
const USER_BIN_DIRS = [".local/bin", ".bun/bin", ".npm-global/bin"]

function findInUserBinDirs(command: string, homeDir: string): string | null {
  for (const dir of USER_BIN_DIRS) {
    const candidate = path.join(homeDir, dir, command)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // missing or not executable — keep looking
    }
  }
  return null
}

/**
 * Resolve a command to an absolute path using a login shell, so binaries the
 * server process's own PATH misses (npm globals, ~/.local/bin) are still
 * found — the server may have been launched from launchd/systemd/cron.
 * Falls back to well-known per-user bin dirs the login shell may not cover.
 */
export function resolveCommandPath(command: string, homeDir = homedir()): string | null {
  if (!/^[\w.-]+$/.test(command)) return null

  // Fast path: the login shell below is a synchronous spawn that blocks the
  // event loop for ~5 ms (up to 24 ms observed here), and callers like
  // diff-store's `gh` runner hit this per invocation. `Bun.which` is ~0.045 ms.
  // It only sees the server's own PATH — which is exactly the gap the login
  // shell exists to cover — so it is a fast path, not a replacement.
  // Deliberately not memoized: callers that need to re-resolve after an install
  // (provider-auth's `fresh` option) must not be served a stale path.
  // PATH is passed explicitly because Bun.which otherwise reads the startup
  // environment and misses what `inheritShellPath` added.
  const direct = Bun.which(command, { PATH: process.env.PATH ?? "" })
  if (direct) return direct

  const result = spawnSync("sh", ["-lc", `command -v -- ${command}`], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
  })
  if (result.status === 0) {
    const resolved = result.stdout?.trim().split("\n").pop()?.trim() ?? ""
    if (resolved.startsWith("/")) return resolved
  }
  return findInUserBinDirs(command, homeDir)
}

const SHELL_PATH_MARKER = "__KANNA_SHELL_PATH__"
export const SHELL_ENV_IMPORTED_ENV_VAR = "KANNA_SHELL_ENV_IMPORTED"
const SHELL_PATH_TIMEOUT_MS = 5_000

/**
 * `current` in its own order, then every `shell` entry it lacks. Appending
 * rather than replacing means a command the server already found keeps
 * resolving to the same binary (e.g. `bun run dev`'s node_modules/.bin).
 */
export function mergePathLists(current: string, shell: string) {
  const entries = [...current.split(path.delimiter), ...shell.split(path.delimiter)]
  return [...new Set(entries.filter(Boolean))].join(path.delimiter)
}

/** The PATH between the two markers, ignoring whatever the rc files print. */
export function parseShellPathOutput(output: string) {
  const [, between] = output.split(SHELL_PATH_MARKER)
  return between?.trim() || null
}

/**
 * Add the user's interactive login shell PATH to this process's PATH.
 *
 * Agents inherit `process.env` whole, and a server started by launchd, a
 * detached `kanna`, or the desktop app gets a PATH that skips ~/.zshrc, where
 * installers like to put ~/.local/bin. Skills then fail with "command not
 * found" for CLIs that work in the user's terminal. `resolveCommandPath`
 * covers the few binaries Kanna runs itself; this covers what agents run.
 *
 * `-i` is what reads ~/.zshrc. `printenv` rather than `$PATH` so fish, which
 * joins list variables with spaces, prints the same thing.
 */
export async function inheritShellPath() {
  if (process.platform === "win32") return
  // The Mac app already started this process with the whole login-shell
  // environment (macos/src/shell-env.ts); a heavy ~/.zshrc costs
  // seconds, so don't pay for it twice.
  if (process.env[SHELL_ENV_IMPORTED_ENV_VAR] === "1") return
  const shell = process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh")
  const script = `echo ${SHELL_PATH_MARKER}; printenv PATH; echo ${SHELL_PATH_MARKER}`
  const output = await new Promise<string>((resolve) => {
    let stdout = ""
    let child
    try {
      child = spawn(shell, ["-ilc", script], {
        stdio: ["ignore", "pipe", "ignore"],
        // oh-my-zsh otherwise asks whether to update, and nobody can answer.
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      })
    } catch {
      resolve("")
      return
    }
    // A slow or hung rc file must not stall boot.
    const timer = setTimeout(() => child.kill("SIGKILL"), SHELL_PATH_TIMEOUT_MS)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => { stdout += chunk })
    child.once("error", () => { clearTimeout(timer); resolve("") })
    child.once("close", () => { clearTimeout(timer); resolve(stdout) })
  })
  const shellPath = parseShellPathOutput(output)
  if (!shellPath) return
  process.env.PATH = mergePathLists(process.env.PATH ?? "", shellPath)
}

export function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}
