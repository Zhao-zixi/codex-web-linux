import { app } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { instanceStatus, releaseInstance, stopInstance } from "./instance"
import { currentMode, devCheckout, fingerprint, pageURL, sameMode, saveMode, type ServerMode } from "./server-mode"
import { reloadShellEnv, shellEnv, which, type Env } from "./shell-env"

/**
 * Keeps one Kanna server running while the app is open.
 *
 * The app is a window around the globally installed `kanna` (bun install -g
 * kanna-code), the same one a terminal runs, so the two are always one
 * version and npm's updater keeps working. The app and the command share one
 * server per data dir (the CLI's single-instance lock,
 * src/server/instance-socket.ts): on launch the app asks the lock for a
 * running server, on whatever port, and adopts it. Only when there is none
 * does it run `kanna --no-open` itself. A terminal's server is left alone
 * when the app quits. For one the app started, the app asks (main.ts): keep
 * it running in the background, or stop it. Either way, if the server goes
 * away while the app is open, the app starts its own, so the window never
 * sits on a dead page. In Development mode (server-mode.ts) the same holds
 * for a checkout's `bun run dev`, which stops with the app.
 */
export type AgentState =
  | { kind: "starting" }
  | { kind: "running"; url: string }
  | { kind: "notInstalled" }
  | { kind: "installing"; line: string }
  /** A custom server that isn't answering yet. */
  | { kind: "waiting"; url: string }
  | { kind: "failed"; message: string }

interface Runtime {
  executable: string
  args: string[]
  cwd: string
  env: Env
}

type Located = { kind: "found"; runtime: Runtime } | { kind: "notInstalled" } | { kind: "unavailable"; message: string }

/** What quitting the app does to the server. */
export type QuitPlan =
  /** Nothing: it's a terminal's, a custom server, or there is none. */
  | { kind: "leave" }
  /** It stops with the app: Development mode, or a `kanna` from before the
   *  lock, which can't be kept running without the app. */
  | { kind: "stop" }
  /** The app started it (or kept it running last time): the user decides. */
  | { kind: "ask"; pid: number; runningChats: number; cloud: boolean }

const MAX_FAILURES = 5

class ServerAgent {
  state: AgentState = { kind: "starting" }
  mode: ServerMode = currentMode()
  onChange: ((state: AgentState) => void) | null = null

  /** Non-null while the app owns the server process. */
  private child: ChildProcess | null = null
  private connecting = false
  private stopping = false
  private failures = 0
  private reachedRunning = false
  private monitor: NodeJS.Timeout | null = null
  private missedHealthChecks = 0
  private readinessToken = 0
  readonly log = new ServerLog()

  get serverURL() {
    return this.state.kind === "running" ? this.state.url : null
  }

  get isOwned() {
    return this.child !== null
  }

  private setState(state: AgentState) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return
    this.state = state
    this.onChange?.(state)
  }

  // Start

  /** Show a server, starting one if needed. `preferred` comes from a
   *  <scheme>://open?url=… link and is only used if it is ours. */
  start(preferred?: string) {
    if (this.serverURL || this.connecting) return
    this.connecting = true
    void this.connect(preferred).finally(() => {
      this.connecting = false
    })
  }

  private async connect(preferred?: string) {
    this.stopping = false
    if (this.mode.kind === "custom") {
      await this.connectToCustom(this.mode.url)
      return
    }
    if (this.state.kind !== "failed") this.setState({ kind: "starting" })
    if (this.mode.kind === "installed") {
      const running = await this.waitForInstance()
      if (running) {
        this.adopt(running)
        return
      }
    }
    const candidates: string[] = []
    if (preferred && this.mode.kind === "installed") candidates.push(preferred)
    candidates.push(pageURL(this.mode))
    for (const candidate of candidates) {
      const url = await probe(candidate, fingerprint(this.mode))
      if (url) {
        this.adopt(url)
        return
      }
    }
    const located = await locate(this.mode)
    if (located.kind === "found") this.launch(located.runtime)
    else if (located.kind === "notInstalled") this.setState({ kind: "notInstalled" })
    else this.setState({ kind: "failed", message: located.message })
  }

  /**
   * The lock knows where a running Kanna listens, and it stays held while
   * the server restarts after an update: wait that out rather than start a
   * second one. Null when none is running.
   */
  private async waitForInstance() {
    const deadline = Date.now() + 120_000
    while (!this.stopping) {
      const status = await instanceStatus(this.mode)
      if (!status) return null
      if (status.port !== null) return localURL(status.port)
      if (Date.now() > deadline) return null
      await sleep(500)
    }
    return null
  }

  /** Someone else runs a custom server: show it once it answers. */
  private async connectToCustom(url: string) {
    const ready = await probe(url, null)
    if (ready) {
      this.adopt(ready)
      return
    }
    this.setState({ kind: "waiting", url })
    // A fresh start() rather than looping here: start() ignores calls while
    // a connect is in flight, and a Server menu switch must not be one.
    setTimeout(() => {
      const mode = this.mode
      if (this.stopping || mode.kind !== "custom" || mode.url !== url || this.state.kind !== "waiting") return
      this.start()
    }, 2_000)
  }

  /** The Server menu. Stops a server the app started for the old mode. */
  switchMode(mode: ServerMode) {
    saveMode(mode)
    if (sameMode(mode, this.mode)) return
    this.mode = mode
    this.restart()
  }

  /** Stop what the app runs and start again (a new mode or checkout). */
  restart() {
    this.stopMonitor()
    this.readinessToken++
    this.failures = 0
    this.setState({ kind: "starting" })
    this.stop(() => this.start())
  }

  private adopt(url: string) {
    if (this.child) this.reachedRunning = true
    this.setState({ kind: "running", url })
    this.missedHealthChecks = 0
    this.startMonitor()
  }

  /** A server started from a terminal exits with its terminal; polling
   *  /health is how the app notices. */
  private startMonitor() {
    this.stopMonitor()
    this.monitor = setInterval(() => void this.checkHealth(), 3_000)
  }

  private stopMonitor() {
    if (this.monitor) clearInterval(this.monitor)
    this.monitor = null
  }

  private async checkHealth() {
    const url = this.serverURL
    if (!url || this.stopping) return
    if (await probe(url, fingerprint(this.mode))) {
      this.missedHealthChecks = 0
      return
    }
    this.missedHealthChecks++
    // An owned process reports its own exit; two misses rule out a server
    // that is only busy.
    if (this.child || this.missedHealthChecks < 2 || this.serverURL !== url) return
    this.stopMonitor()
    this.setState({ kind: "starting" })
    this.start()
  }

  // Launch

  private launch(runtime: Runtime) {
    this.reachedRunning = false
    const log = this.log.begin([runtime.executable, ...runtime.args].join(" "))

    let child: ChildProcess
    try {
      child = spawn(runtime.executable, runtime.args, {
        cwd: runtime.cwd,
        env: runtime.env,
        // Into the log file rather than a pipe to the app: a server kept
        // running after the app quits would fail its next write to a pipe
        // nobody reads.
        stdio: ["ignore", log ?? "ignore", log ?? "ignore"],
        // Its own process group, so nothing aimed at the app's reaches a
        // server the user keeps running.
        detached: this.mode.kind === "installed",
      })
    } catch (error) {
      this.log.write(`failed to start: ${String(error)}\n`)
      this.recordFailure(`Kanna didn't start: ${String(error)}`)
      return
    }
    this.child = child
    child.on("error", (error) => {
      if (this.child !== child) return
      this.child = null
      this.log.write(`failed to start: ${error.message}\n`)
      this.recordFailure(`Kanna didn't start: ${error.message}`)
    })
    child.on("exit", (code, signal) => this.didExit(child, code, signal))
    void this.awaitReady(child)
  }

  /** Ready once the lock reports a port. Development mode waits for Vite's
   *  page instead, and a `kanna` from before the lock answers /health on the
   *  default port. */
  private async awaitReady(child: ChildProcess) {
    const token = ++this.readinessToken
    const print = fingerprint(this.mode)
    while (token === this.readinessToken && this.child === child && child.exitCode === null) {
      const status = this.mode.kind === "installed" ? await instanceStatus(this.mode) : null
      const ready = status?.port != null ? localURL(status.port) : await probe(pageURL(this.mode), print)
      if (ready && token === this.readinessToken && this.child === child) {
        this.failures = 0
        this.adopt(ready)
        return
      }
      await sleep(500)
    }
  }

  private didExit(exited: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (exited !== this.child) return
    this.child = null
    this.readinessToken++
    const status = code ?? signal ?? "unknown"
    this.log.write(`\n[exited with status ${status}]\n`)
    if (this.stopping) return
    void this.afterExit(status)
  }

  private async afterExit(status: number | string) {
    // A `kanna` that found one already running exits right away. If that's
    // the one on screen, keep showing it.
    const shown = this.serverURL
    if (shown && (await probe(shown, fingerprint(this.mode)))) return
    this.stopMonitor()
    const somethingRunning =
      this.reachedRunning ||
      (await instanceStatus(this.mode)) !== null ||
      (await probe(pageURL(this.mode), fingerprint(this.mode))) !== null
    if (somethingRunning) {
      // It ran and then died, or another is starting: connect again.
      this.setState({ kind: "starting" })
      this.start()
    } else {
      this.recordFailure(this.log.tail(6) || `Kanna stopped (status ${status}).`)
    }
  }

  private recordFailure(message: string) {
    this.failures++
    if (this.failures >= MAX_FAILURES) {
      this.setState({ kind: "failed", message })
      return
    }
    this.setState({ kind: "starting" })
    setTimeout(() => this.start(), this.failures * 2_000)
  }

  /** "Try Again" after a failure, or after installing `kanna` by hand. */
  retry() {
    this.failures = 0
    this.setState({ kind: "starting" })
    reloadShellEnv()
    this.start()
  }

  // Install

  /** `bun install -g kanna-code`, installing Bun first when it's missing (to
   *  ~/.bun, the way bun.sh/install does it for a terminal). Afterwards the
   *  app runs the same `kanna` a terminal would, and npm updates it. */
  async install() {
    this.setState({ kind: "installing", line: "Starting…" })
    this.log.begin("install kanna-code")
    const env = await shellEnv()
    const status = await runInstaller(env, (line) => {
      this.log.write(line + "\n")
      if (line.trim()) this.setState({ kind: "installing", line })
    })
    if (status === 0) this.retry()
    else this.setState({ kind: "failed", message: `Installing Kanna failed (status ${status}). Show Log has the installer's output.` })
  }

  // Quit

  async quitPlan(): Promise<QuitPlan> {
    if (this.mode.kind === "installed") {
      const status = await instanceStatus(this.mode)
      if (status) {
        return status.owner === "terminal"
          ? { kind: "leave" }
          : { kind: "ask", pid: status.pid, runningChats: status.runningChats ?? 0, cloud: status.cloud ?? false }
      }
    }
    return this.child ? { kind: "stop" } : { kind: "leave" }
  }

  /** Quit without the server: it keeps running in the background, and the
   *  app finds it again the next time it opens. */
  async keepRunning() {
    if (!(await releaseInstance(this.mode))) return false
    this.stopping = true
    this.stopMonitor()
    const child = this.child
    if (child) {
      child.removeAllListeners("exit")
      child.unref()
      this.child = null
    }
    return true
  }

  /** Stop the server, whoever's process it is now, and wait until it has. */
  async goOffline(pid: number) {
    this.stopping = true
    this.stopMonitor()
    if (!(await stopInstance(this.mode))) {
      await new Promise<void>((resolve) => this.stop(resolve))
      return
    }
    // The same time stop() gives it: running turns cancel (they resume on
    // the next start), logs compact, and kanna.sh marks this Mac offline.
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (!(await instanceStatus(this.mode))) return
      await sleep(250)
    }
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }

  // Stop

  /** Stop a server this app started, then call `done`. SIGTERM reaches the
   *  CLI's supervisor, which passes it on; the server cancels running turns
   *  (they resume on next start), compacts its logs and marks the machine
   *  offline on kanna.sh, so it gets time to finish. SIGKILL only if it hangs. */
  stop(done: () => void) {
    this.stopping = true
    this.stopMonitor()
    const child = this.child
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      done()
      return
    }
    const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000)
    child.once("exit", () => {
      clearTimeout(deadline)
      done()
    })
    child.kill("SIGTERM")
  }
}

// Probe

/** `http://localhost:<port>`. Always localhost, never 127.0.0.1: the web
 *  client keeps its preferences in localStorage, which is per origin. */
export function localURL(port: number) {
  return `http://localhost:${port}`
}

export function isLoopback(host: string) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)
}

/** The server's URL if a Kanna answers /health at `url`. With a fingerprint,
 *  only a local one serving that data dir counts; without one (a custom
 *  server), any Kanna at that address does. */
export async function probe(url: string, print: string | null): Promise<string | null> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (print) {
    if (!isLoopback(parsed.hostname) || !parsed.port) return null
    const body = await health(`http://127.0.0.1:${parsed.port}/health`, 1_000)
    return body?.ok === true && body.instance === print ? localURL(Number(parsed.port)) : null
  }
  const body = await health(new URL("/health", parsed).toString(), 2_000)
  return body?.ok === true ? url : null
}

async function health(url: string, timeout: number) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (response.status !== 200) return null
    return (await response.json()) as { ok?: unknown; instance?: unknown }
  } catch {
    return null
  }
}

// Runtime

/** How to start the server for a mode. Installed: the `kanna` on the user's
 *  PATH, which is the CLI's supervisor, so it restarts in place after an npm
 *  update. Development: `bun run dev` in the checkout. */
async function locate(mode: ServerMode): Promise<Located> {
  const env = { ...(await shellEnv()) }
  // src/server/mac-app.ts: what the app starts exits if the app crashes
  // instead of outliving it.
  env.KANNA_EXIT_WITH_PARENT = "1"
  // The lock records who started it, which decides what quitting asks.
  env.KANNA_STARTED_BY = "app"
  // The server skips its own login-shell PATH lookup; this env already has it.
  env.KANNA_SHELL_ENV_IMPORTED = "1"

  if (mode.kind === "installed") {
    const kanna = which("kanna", env)
    if (!kanna) return { kind: "notInstalled" }
    return { kind: "found", runtime: { executable: kanna, args: ["--no-open"], cwd: os.homedir(), env } }
  }
  if (mode.kind === "development") {
    const checkout = devCheckout()
    if (!checkout) {
      return {
        kind: "unavailable",
        message: "Development mode needs a Kanna checkout. Choose one with Server › Choose Checkout…, or switch to Server › Installed Kanna.",
      }
    }
    const bun = which("bun", env)
    if (!bun) return { kind: "unavailable", message: "Development mode runs `bun run dev`, and Bun isn't on your PATH." }
    return { kind: "found", runtime: { executable: bun, args: ["run", "./scripts/dev.ts"], cwd: checkout, env } }
  }
  return { kind: "unavailable", message: "A custom server is started by whoever runs it." }
}

// Installer

const INSTALL_SCRIPT = `
set -e
if ! command -v bun >/dev/null 2>&1; then
  echo "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi
echo "Installing kanna-code…"
bun install -g kanna-code
echo "Installed $(kanna --version 2>/dev/null || echo kanna)"
`

/** Runs the install, reporting each output line; resolves the exit status. */
function runInstaller(env: Env, onLine: (line: string) => void) {
  return new Promise<number>((resolve) => {
    const child = spawn("/bin/bash", ["-c", INSTALL_SCRIPT], { env, cwd: os.homedir(), stdio: ["ignore", "pipe", "pipe"] })
    let buffer = ""
    const consume = (data: Buffer) => {
      buffer += data.toString("utf8")
      // Progress bars redraw with \r; treat it as a line break too.
      let index: number
      while ((index = buffer.search(/[\r\n]/)) >= 0) {
        onLine(buffer.slice(0, index))
        buffer = buffer.slice(index + 1)
      }
    }
    child.stdout.on("data", consume)
    child.stderr.on("data", consume)
    child.on("error", () => resolve(-1))
    child.on("close", (code) => resolve(code ?? -1))
  })
}

/** ~/Library/Logs/Kanna/server.log: everything the app's server
 *  (and the installer) prints. Help › Show Server Log opens it. */
class ServerLog {
  readonly file = path.join(os.homedir(), "Library", "Logs", app.getName(), "server.log")
  private fd: number | null = null

  /** The file descriptor the server writes to. A server kept running after
   *  the app quits holds it open; it appends, so truncating the file here
   *  later is safe. */
  begin(command: string) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const size = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0
      if (size > 5_000_000 && this.fd !== null) {
        fs.closeSync(this.fd)
        this.fd = null
      }
      this.fd ??= fs.openSync(this.file, size > 5_000_000 ? "w" : "a")
    } catch {
      return null
    }
    this.write(`\n=== ${new Date().toString()} ${command}\n`)
    return this.fd
  }

  /** The last lines, for the failure screen. */
  tail(lines: number) {
    try {
      const size = fs.statSync(this.file).size
      const length = Math.min(size, 8_192)
      const buffer = Buffer.alloc(length)
      const fd = fs.openSync(this.file, "r")
      try {
        fs.readSync(fd, buffer, 0, length, size - length)
      } finally {
        fs.closeSync(fd)
      }
      const text = buffer.toString("utf8").split("\n=== ").pop() ?? ""
      return text.split("\n").slice(1).filter((line) => line.trim()).slice(-lines).join("\n")
    } catch {
      return ""
    }
  }

  write(data: string | Buffer) {
    if (this.fd === null) return
    try {
      fs.writeSync(this.fd, typeof data === "string" ? Buffer.from(data) : data)
    } catch {}
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Last: the agent's fields make a ServerLog, and a class isn't usable above
// its declaration.
export const agent = new ServerAgent()
