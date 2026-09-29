import { app } from "electron"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { currentMode, devCheckout, fingerprint, pageURL, sameMode, saveMode, type ServerMode } from "./server-mode"
import { reloadShellEnv, shellEnv, which, type Env } from "./shell-env"

/**
 * Keeps one Kanna server running while the app is open.
 *
 * The app is a window around the globally installed `kanna` (bun install -g
 * kanna-code), the same one a terminal runs, so the two are always one
 * version and npm's updater keeps working. The app and the command share one
 * server per data dir (the CLI's single-instance guard,
 * src/server/instance.ts): on launch the app first looks for a server a
 * terminal already started and adopts it, and only when there is none does it
 * run `kanna --no-open` itself. A server the app started dies with the app;
 * an adopted one belongs to its terminal and is left alone. Either way, if
 * the server goes away while the app is open, the app starts its own, so the
 * window never sits on a dead page. In Development mode (server-mode.ts) the
 * same holds for a checkout's `bun run dev`.
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
  private outputBuffer = ""
  private recentOutput: string[] = []
  private adoptAfterExit: string | null = null
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
    this.outputBuffer = ""
    this.recentOutput = []
    this.reachedRunning = false
    this.adoptAfterExit = null
    this.log.begin([runtime.executable, ...runtime.args].join(" "))

    let child: ChildProcess
    try {
      child = spawn(runtime.executable, runtime.args, {
        cwd: runtime.cwd,
        env: runtime.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
    } catch (error) {
      this.log.write(`failed to start: ${String(error)}\n`)
      this.recordFailure(`Kanna didn't start: ${String(error)}`)
      return
    }
    this.child = child
    child.stdout?.on("data", (data: Buffer) => this.consume(data))
    child.stderr?.on("data", (data: Buffer) => this.consume(data))
    child.on("error", (error) => {
      if (this.child !== child) return
      this.child = null
      this.log.write(`failed to start: ${error.message}\n`)
      this.recordFailure(`Kanna didn't start: ${error.message}`)
    })
    child.on("exit", (code, signal) => this.didExit(child, code, signal))
    // `bun run dev` prints the server's port before Vite serves a page, so
    // wait for the page itself.
    if (this.mode.kind === "development") void this.awaitPage(child)
  }

  private async awaitPage(child: ChildProcess) {
    const token = ++this.readinessToken
    const url = pageURL(this.mode)
    const print = fingerprint(this.mode)
    while (token === this.readinessToken && this.child === child && child.exitCode === null) {
      const ready = await probe(url, print)
      if (ready && token === this.readinessToken && this.child === child) {
        this.failures = 0
        this.adopt(ready)
        return
      }
      await sleep(500)
    }
  }

  private consume(data: Buffer) {
    this.log.write(data)
    this.outputBuffer += data.toString("utf8")
    let newline: number
    while ((newline = this.outputBuffer.indexOf("\n")) >= 0) {
      const line = this.outputBuffer.slice(0, newline)
      this.outputBuffer = this.outputBuffer.slice(newline + 1)
      this.handleLine(line)
    }
  }

  /** The CLI's own log lines are the contract (src/server/cli-runtime.ts):
   *  "[kanna] listening on http://127.0.0.1:<port>" once the port is bound
   *  (again after each update restart), and "kanna is already running at
   *  <url>" when a terminal won a race. */
  private handleLine(line: string) {
    this.recentOutput.push(line)
    if (this.recentOutput.length > 30) this.recentOutput.splice(0, this.recentOutput.length - 30)

    const listening = this.mode.kind === "installed" && line.match(/\[kanna\] listening on http:\/\/\S*:(\d+)\s*$/)
    if (listening) {
      this.reachedRunning = true
      this.failures = 0
      this.adopt(localURL(Number(listening[1])))
      return
    }
    const already = line.match(/is already running at (\S+)/)
    if (already) {
      try {
        this.adoptAfterExit = new URL(already[1]).toString().replace(/\/$/, "")
      } catch {}
    }
  }

  private didExit(exited: ChildProcess, code: number | null, signal: NodeJS.Signals | null) {
    if (exited !== this.child) return
    this.child = null
    this.readinessToken++
    const status = code ?? signal ?? "unknown"
    this.log.write(`\n[exited with status ${status}]\n`)
    if (this.stopping) return
    this.stopMonitor()

    if (this.adoptAfterExit) {
      const url = this.adoptAfterExit
      this.setState({ kind: "starting" })
      this.start(url)
    } else if (this.reachedRunning) {
      // It ran and then died: start a fresh one right away.
      this.setState({ kind: "starting" })
      this.start()
    } else {
      const tail = this.recentOutput.slice(-6).join("\n")
      this.recordFailure(tail || `Kanna stopped (status ${status}).`)
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
      return
    }
    this.write(`\n=== ${new Date().toString()} ${command}\n`)
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
