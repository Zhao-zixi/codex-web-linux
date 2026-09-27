import type { TerminalSnapshot } from "../shared/protocol"

const PROMPT_COLOR = "\x1b[38;5;204m"
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

export interface DemoShellContext {
  /** `~/Projects/name`, for the prompt and `pwd`. */
  displayPath: string
  absolutePath: string
  listFiles: () => string[]
  readFile: (path: string) => string | null
  gitStatus: () => string
  branchName: string
}

/**
 * A pretend shell for the terminal panel. It answers a handful of commands
 * from the demo project's files and points everything else at the real
 * install, so typing into it never looks broken.
 */
export class DemoShell {
  private output = ""
  private line = ""

  constructor(
    readonly terminalId: string,
    private readonly context: DemoShellContext,
    private readonly emit: (data: string, version: number) => void,
    private cols: number,
    private rows: number,
  ) {
    this.output = `${DIM}This terminal is simulated. Try ls, git status, or cat README.md.${RESET}\r\n${this.prompt()}`
  }

  snapshot(): TerminalSnapshot {
    return {
      terminalId: this.terminalId,
      title: "zsh",
      cwd: this.context.absolutePath,
      shell: "/bin/zsh",
      cols: this.cols,
      rows: this.rows,
      scrollback: 1000,
      serializedState: this.output,
      status: "running",
      exitCode: null,
      outputVersion: this.output.length,
    }
  }

  tail(sinceVersion: number | null) {
    if (sinceVersion === null || sinceVersion > this.output.length) return null
    return { data: this.output.slice(sinceVersion), version: this.output.length }
  }

  resize(cols: number, rows: number) {
    this.cols = cols
    this.rows = rows
  }

  input(data: string) {
    // Arrow keys and other escape sequences would need line editing and
    // history; dropping them keeps the prompt intact.
    if (data.startsWith("\x1b")) return
    let echo = ""
    for (const char of data) {
      if (char === "\r" || char === "\n") {
        echo += `\r\n${this.run(this.line.trim())}${this.prompt()}`
        this.line = ""
      } else if (char === "\x7f" || char === "\b") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1)
          echo += "\b \b"
        }
      } else if (char === "\x03") {
        echo += `^C\r\n${this.prompt()}`
        this.line = ""
      } else if (char === "\x0c") {
        echo += `\x1b[2J\x1b[H${this.prompt()}${this.line}`
      } else if (char >= " ") {
        this.line += char
        echo += char
      }
    }
    if (echo) this.write(echo)
  }

  private write(data: string) {
    this.output += data
    this.emit(data, this.output.length)
  }

  private prompt() {
    return `${PROMPT_COLOR}${this.context.displayPath}${RESET} ${DIM}(${this.context.branchName})${RESET} $ `
  }

  private run(commandLine: string): string {
    if (!commandLine) return ""
    const [command = "", ...args] = commandLine.split(/\s+/)
    const lines = (text: string) => (text ? `${text.replace(/\n/g, "\r\n")}\r\n` : "")
    switch (command) {
      case "ls": {
        const entries = new Set(this.context.listFiles().map((path) => path.split("/")[0]!))
        return lines([...entries].sort().join("  "))
      }
      case "pwd":
        return lines(this.context.absolutePath)
      case "whoami":
        return lines("you")
      case "echo":
        return lines(args.join(" "))
      case "clear":
        return "\x1b[2J\x1b[H"
      case "cat": {
        const path = args[0]
        if (!path) return ""
        const content = this.context.readFile(path)
        return content === null
          ? lines(`cat: ${path}: No such file or directory`)
          : lines(content.replace(/\n$/, ""))
      }
      case "git":
        if (args[0] === "status") {
          const status = this.context.gitStatus()
          return lines(status || `On branch ${this.context.branchName}\nnothing to commit, working tree clean`)
        }
        if (args[0] === "branch") return lines(`* ${this.context.branchName}`)
        break
    }
    return lines(`${command}: not available in the demo. Install Kanna for a real terminal:\n  bun install -g kanna-code`)
  }
}
