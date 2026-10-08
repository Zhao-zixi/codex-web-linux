import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { applyUtf8Locale, resolveShell, TerminalManager, TerminalOutputLog } from "./terminal-manager"

const SHELL_START_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 5_000
const FOCUS_IN_SEQUENCE = "\x1b[I"
const RAW_READ_HEX_COMMAND = `python3 -c 'import os,sys,tty,termios,select; fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd); print("__RAW_READY__", flush=True); r,_,_=select.select([fd],[],[],1); data=os.read(fd,8) if r else b""; print(data.hex() or "__EMPTY__", flush=True); termios.tcsetattr(fd,termios.TCSADRAIN,old)'\r`
const RAW_READ_BYTE_COMMAND = `stty raw -echo; printf '__RAW_READY__\\n'; dd bs=1 count=1 2>/dev/null | od -An -tu1; stty sane; printf '%s%s\\n' '__RAW_' 'DONE'\r`

const isSupportedPlatform = process.platform !== "win32" && typeof Bun.Terminal === "function"
const describeIfSupported = isSupportedPlatform ? describe : describe.skip

let tempProjectPath = ""
let tempHomePath = ""
const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const originalHistfile = process.env.HISTFILE

beforeAll(async () => {
  if (!isSupportedPlatform) return
  tempProjectPath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-manager-"))
  tempHomePath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-home-"))
  await mkdir(path.join(tempHomePath, ".config"), { recursive: true })
  process.env.HOME = tempHomePath
  process.env.ZDOTDIR = tempHomePath
  process.env.HISTFILE = path.join(tempHomePath, ".zsh_history")
})

afterEach(async () => {
  if (!tempProjectPath) return
  await rm(tempProjectPath, { recursive: true, force: true })
  tempProjectPath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-manager-"))
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }

  if (originalZdotdir === undefined) {
    delete process.env.ZDOTDIR
  } else {
    process.env.ZDOTDIR = originalZdotdir
  }

  if (originalHistfile === undefined) {
    delete process.env.HISTFILE
  } else {
    process.env.HISTFILE = originalHistfile
  }

  if (tempHomePath) {
    await rm(tempHomePath, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 25) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function createSession(terminalId: string) {
  const manager = new TerminalManager()
  let output = ""
  manager.onEvent((event) => {
    if (event.type === "terminal.output" && event.terminalId === terminalId) {
      output += event.data
    }
  })

  manager.createTerminal({
    projectPath: tempProjectPath,
    terminalId,
    cols: 80,
    rows: 24,
    scrollback: 1_000,
  })

  manager.write(terminalId, "printf '__KANNA_READY__\\n'\r")
  await waitFor(() => output.includes("__KANNA_READY__"), SHELL_START_TIMEOUT_MS)

  return {
    manager,
    getOutput: () => output,
  }
}

async function waitForOutputToContain(getOutput: () => string, value: string, timeoutMs = COMMAND_TIMEOUT_MS) {
  await waitFor(() => getOutput().includes(value), timeoutMs)
}

describeIfSupported("TerminalManager", () => {
  test("ignores an unknown detected shell and falls back to an executable SHELL", () => {
    expect(resolveShell({ detectedShell: "unknown", envShell: "/bin/bash", platform: "linux" })).toBe("/bin/bash")
  })

  test("ignores non-executable shell candidates and uses the Unix fallback", () => {
    expect(resolveShell({ detectedShell: "/missing/kanna-shell", envShell: "/missing/also-missing", platform: "linux" })).toBe("/bin/sh")
  })

  test("ignores Bun's unknown SHELL value", () => {
    expect(resolveShell({ detectedShell: "unknown", envShell: "unknown", platform: "linux" })).toBe("/bin/sh")
  })

  test("keeps a detected executable shell ahead of SHELL", () => {
    expect(resolveShell({ detectedShell: "/bin/sh", envShell: "/bin/bash", platform: "linux" })).toBe("/bin/sh")
  })

  test("ctrl+c interrupts the foreground job and keeps the shell alive", async () => {
    const terminalId = "terminal-ctrl-c-foreground"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      manager.write(terminalId, `python3 -c "import time; print('__KANNA_SLEEP__', flush=True); time.sleep(30)"\r`)
      await waitFor(() => getOutput().includes("__KANNA_SLEEP__"), COMMAND_TIMEOUT_MS)

      manager.write(terminalId, "\x03")
      manager.write(terminalId, "printf '__KANNA_AFTER_INT__\\n'\r")

      await waitFor(() => getOutput().includes("__KANNA_AFTER_INT__"), COMMAND_TIMEOUT_MS)

      const snapshot = manager.getSnapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput()).toContain("__KANNA_AFTER_INT__")
    } finally {
      manager.close(terminalId)
    }
  })

  test("ctrl+c at an idle prompt does not exit the shell", async () => {
    const terminalId = "terminal-ctrl-c-prompt"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const before = getOutput()
      manager.write(terminalId, "\x03")

      await waitFor(() => getOutput().length > before.length, COMMAND_TIMEOUT_MS)

      const snapshot = manager.getSnapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput().length).toBeGreaterThan(before.length)
    } finally {
      manager.close(terminalId)
    }
  })

  test("passes Ctrl-C as a byte to programs that put the PTY in raw mode", async () => {
    if (process.platform !== "linux") return
    const terminalId = "terminal-ctrl-c-raw-mode"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      manager.write(terminalId, RAW_READ_BYTE_COMMAND)
      await waitForOutputToContain(getOutput, "__RAW_READY__")
      manager.write(terminalId, "\x03")
      await waitForOutputToContain(getOutput, "__RAW_DONE\r\n")

      const cleanedOutput = getOutput().replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      expect(cleanedOutput.split(/[\r\n]+/).some((line) => line.trim() === "3")).toBe(true)
      expect(manager.getSnapshot(terminalId)?.status).toBe("running")
    } finally {
      manager.close(terminalId)
    }
  })

  test("closing a PTY with a foreground job leaves no child process", async () => {
    if (process.platform !== "linux") return
    const terminalId = "terminal-close-foreground-job"
    const { manager, getOutput } = await createSession(terminalId)
    const state = manager as unknown as { sessions: Map<string, { process: Bun.Subprocess | null }> }

    try {
      manager.write(terminalId, "sleep 30\r")
      await waitForOutputToContain(getOutput, "sleep 30")
      const shellPid = state.sessions.get(terminalId)?.process?.pid
      expect(typeof shellPid).toBe("number")
      const children = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,comm="]).stdout.toString().split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([, parentPid, command]) => parentPid === String(shellPid) && command === "sleep")
      const sleepPid = Number(children[0]?.[0])
      expect(sleepPid).toBeGreaterThan(1)
      manager.close(terminalId)
      await waitFor(() => {
        const state = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleepPid)]).stdout.toString().trim()
        return !state
      }, COMMAND_TIMEOUT_MS)
      expect(Bun.spawnSync(["ps", "-o", "stat=", "-p", String(sleepPid)]).stdout.toString().trim()).toBe("")
    } finally {
      manager.close(terminalId)
    }
  })

  test("ctrl+d preserves eof behavior", async () => {
    const terminalId = "terminal-ctrl-d"
    const { manager } = await createSession(terminalId)

    try {
      manager.write(terminalId, "\x04")

      await waitFor(() => manager.getSnapshot(terminalId)?.status === "exited", COMMAND_TIMEOUT_MS)

      expect(manager.getSnapshot(terminalId)?.exitCode).toBe(0)
    } finally {
      manager.close(terminalId)
    }
  })

  test("filters leaked focus reports while focus mode is disabled", async () => {
    const terminalId = "terminal-focus-filtered"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const beforeLength = getOutput().length
      manager.write(terminalId, RAW_READ_HEX_COMMAND)
      await waitForOutputToContain(getOutput, "__RAW_READY__")

      manager.write(terminalId, FOCUS_IN_SEQUENCE)
      await waitForOutputToContain(getOutput, "__EMPTY__")

      const interactionOutput = getOutput().slice(beforeLength)
      expect(interactionOutput).toContain("__EMPTY__")
      expect(interactionOutput).not.toContain("1b5b49")
    } finally {
      manager.close(terminalId)
    }
  })

  test("forwards focus reports when the session mode is enabled", () => {
    const manager = new TerminalManager() as unknown as {
      sessions: Map<
        string,
        {
          status: "running" | "exited"
          focusReportingEnabled: boolean
          terminal: { write: (data: string) => void }
          process: Bun.Subprocess | null
        }
      >
      write: (terminalId: string, data: string) => void
    }
    const writes: string[] = []

    manager.sessions.set("terminal-focus-forwarded", {
      status: "running",
      focusReportingEnabled: true,
      terminal: {
        write(data: string) {
          writes.push(data)
        },
      },
      process: null,
    })

    manager.write("terminal-focus-forwarded", FOCUS_IN_SEQUENCE)

    expect(writes).toEqual([FOCUS_IN_SEQUENCE])
  })

  test("resize signals the shell process group with SIGWINCH", () => {
    const manager = new TerminalManager() as unknown as {
      sessions: Map<
        string,
        {
          cols: number
          rows: number
          headless: { resize: (cols: number, rows: number) => void }
          terminal: { resize: (cols: number, rows: number) => void }
          process: { pid: number } | null
        }
      >
      resize: (terminalId: string, cols: number, rows: number) => void
    }
    const resizeCalls: Array<{ cols: number; rows: number }> = []
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const originalKill = process.kill

    ;(process as typeof process & {
      kill: (pid: number, signal?: NodeJS.Signals | number) => boolean
    }).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (typeof signal === "string") {
        killCalls.push({ pid, signal })
      }
      return true
    }) as typeof process.kill

    manager.sessions.set("terminal-resize-sigwinch", {
      cols: 80,
      rows: 24,
      headless: {
        resize(cols, rows) {
          resizeCalls.push({ cols, rows })
        },
      },
      terminal: {
        resize(cols, rows) {
          resizeCalls.push({ cols, rows })
        },
      },
      process: { pid: 4321 },
    })

    try {
      manager.resize("terminal-resize-sigwinch", 120, 40)
    } finally {
      process.kill = originalKill
    }

    expect(resizeCalls).toEqual([
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
    ])
    expect(killCalls).toContainEqual({ pid: -4321, signal: "SIGWINCH" })
  })

  test("new sessions reset focus mode back to filtered", async () => {
    const manager = new TerminalManager()
    const firstTerminalId = "terminal-focus-first"
    const secondTerminalId = "terminal-focus-second"
    let outputByTerminalId = new Map<string, string>()

    manager.onEvent((event) => {
      if (event.type !== "terminal.output") return
      outputByTerminalId.set(event.terminalId, `${outputByTerminalId.get(event.terminalId) ?? ""}${event.data}`)
    })

    const getOutput = (terminalId: string) => outputByTerminalId.get(terminalId) ?? ""

    const createManagedSession = async (terminalId: string) => {
      manager.createTerminal({
        projectPath: tempProjectPath,
        terminalId,
        cols: 80,
        rows: 24,
        scrollback: 1_000,
      })
      manager.write(terminalId, "printf '__KANNA_READY__\\n'\r")
      await waitForOutputToContain(() => getOutput(terminalId), "__KANNA_READY__", SHELL_START_TIMEOUT_MS)
    }

    try {
      await createManagedSession(firstTerminalId)
      const firstBeforeLength = getOutput(firstTerminalId).length
      manager.write(firstTerminalId, "printf '\\033[?1004h'\r")
      await waitFor(() => getOutput(firstTerminalId).length > firstBeforeLength, COMMAND_TIMEOUT_MS)
      manager.close(firstTerminalId)

      await createManagedSession(secondTerminalId)
      const before = getOutput(secondTerminalId).length
      manager.write(secondTerminalId, "cat -v\r")
      await waitFor(() => getOutput(secondTerminalId).length > before, COMMAND_TIMEOUT_MS)
      manager.write(secondTerminalId, FOCUS_IN_SEQUENCE)
      manager.write(secondTerminalId, "\x03")
      manager.write(secondTerminalId, "printf '__KANNA_FRESH_SESSION__\\n'\r")
      await waitForOutputToContain(() => getOutput(secondTerminalId), "__KANNA_FRESH_SESSION__")

      const interactionOutput = getOutput(secondTerminalId).slice(before)
      expect(interactionOutput).not.toContain("^[[I")
    } finally {
      manager.close(firstTerminalId)
      manager.close(secondTerminalId)
    }
  })

  // PTY reads split at arbitrary byte offsets. Decoding each chunk in
  // isolation turns any character straddling a boundary into U+FFFD. A real
  // PTY gives no control over where reads land, so drive the output handler
  // directly and split at every byte position of a multi-byte sequence.
  test("does not corrupt multi-byte characters split across PTY read boundaries", async () => {
    const terminalId = "terminal-utf8-boundaries"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const internals = manager as unknown as {
        sessions: Map<string, object>
        handlePtyOutput: (session: object, data: Uint8Array) => void
      }
      const session = internals.sessions.get(terminalId)
      expect(session).toBeDefined()

      // 2-, 3- and 4-byte sequences: accented Latin, box drawing, CJK, emoji.
      const payload = "é─日🎉"
      const bytes = Buffer.from(payload, "utf8")

      for (let cut = 1; cut < bytes.length; cut++) {
        const before = getOutput().length
        internals.handlePtyOutput(session!, bytes.subarray(0, cut))
        internals.handlePtyOutput(session!, bytes.subarray(cut))
        expect(getOutput().slice(before)).toBe(payload)
      }
    } finally {
      manager.close(terminalId)
    }
  })

  test("round-trips a large UTF-8 stream through a real PTY", async () => {
    const terminalId = "terminal-utf8-stream"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const line = "🎉👻🐣─│┌┐└┘áéíóú日本語"
      const repeats = 4_000
      const fixturePath = path.join(tempProjectPath, "utf8-fixture.txt")
      await Bun.write(fixturePath, `${`${line}\n`.repeat(repeats)}__KANNA_UTF8_DONE__\n`)

      const before = getOutput().length
      manager.write(terminalId, `cat ${fixturePath}\r`)
      await waitForOutputToContain(getOutput, "__KANNA_UTF8_DONE__", 20_000)

      const streamed = getOutput().slice(before)
      expect(Buffer.byteLength(streamed, "utf8")).toBeGreaterThan(200_000)
      expect(streamed).not.toInclude("�")
      expect(streamed.split("🎉").length - 1).toBe(repeats)
      expect(streamed.split("日本語").length - 1).toBe(repeats)
    } finally {
      manager.close(terminalId)
    }
  }, 30_000)

  test("runs the shadow terminal on Unicode 11 width tables", async () => {
    const terminalId = "terminal-unicode-version"
    const { manager } = await createSession(terminalId)

    try {
      const sessions = (manager as unknown as {
        sessions: Map<string, { headless: { unicode: { activeVersion: string } } }>
      }).sessions
      expect(sessions.get(terminalId)?.headless.unicode.activeVersion).toBe("11")
    } finally {
      manager.close(terminalId)
    }
  })
})

describe("applyUtf8Locale", () => {
  test("sets a UTF-8 LANG when the environment specifies none", () => {
    const env = applyUtf8Locale({ PATH: "/usr/bin" })
    expect(env.LANG).toMatch(/\.UTF-8$/i)
  })

  test("leaves an existing UTF-8 locale untouched", () => {
    const env = applyUtf8Locale({ LANG: "en_GB.UTF-8" })
    expect(env.LANG).toBe("en_GB.UTF-8")
    expect(env.LC_ALL).toBeUndefined()
  })

  test("overrides LC_ALL and LC_CTYPE when they force ASCII", () => {
    // Both outrank LANG in POSIX precedence, so setting LANG alone would not
    // actually give the shell a UTF-8 locale.
    const env = applyUtf8Locale({ LC_ALL: "C", LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" })
    expect(env.LC_ALL).toMatch(/\.UTF-8$/i)
    expect(env.LC_CTYPE).toMatch(/\.UTF-8$/i)
  })

  test("treats a non-UTF-8 LC_CTYPE as authoritative over a UTF-8 LANG", () => {
    const env = applyUtf8Locale({ LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" })
    expect(env.LC_CTYPE).toMatch(/\.UTF-8$/i)
    // The already-valid LANG is a deliberate regional choice — keep it.
    expect(env.LANG).toBe("en_US.UTF-8")
  })

  test("keeps a deliberate UTF-8 LC_ALL", () => {
    const env = applyUtf8Locale({ LC_ALL: "ja_JP.UTF-8", LANG: "C" })
    expect(env.LC_ALL).toBe("ja_JP.UTF-8")
    expect(env.LANG).toBe("C")
  })
})

describe("TerminalOutputLog", () => {
  test("versions are a running character count", () => {
    const log = new TerminalOutputLog()
    expect(log.append("abc")).toBe(3)
    expect(log.append("")).toBe(3)
    expect(log.append("de")).toBe(5)
    expect(log.version).toBe(5)
  })

  test("a tail starts exactly where the client stopped, across chunks", () => {
    const log = new TerminalOutputLog()
    log.append("hello ")
    log.append("world")
    log.append("!")
    expect(log.tailSince(0)).toBe("hello world!")
    expect(log.tailSince(3)).toBe("lo world!")
    expect(log.tailSince(6)).toBe("world!")
    expect(log.tailSince(12)).toBe("")
  })

  test("a version outside what is held is refused rather than guessed", () => {
    const log = new TerminalOutputLog()
    log.append("abc")
    expect(log.tailSince(4)).toBeNull()
    expect(log.tailSince(-1)).toBeNull()
    expect(log.tailSince(1.5)).toBeNull()
  })

  test("small writes pack into segments instead of one object each", () => {
    const log = new TerminalOutputLog(1_000, 100)
    for (let i = 0; i < 500; i += 1) log.append("x")
    expect(log.segmentCount).toBe(5)
    expect(log.tailSince(0)).toBe("x".repeat(500))
    expect(log.tailSince(150)).toBe("x".repeat(350))
  })

  test("old output falls off the front once the limit is passed", () => {
    const log = new TerminalOutputLog(10, 4)
    log.append("aaaa")
    log.append("bbbb")
    log.append("cccc")
    // The first chunk is gone; a tail from inside it cannot be served.
    expect(log.tailSince(0)).toBeNull()
    expect(log.tailSince(3)).toBeNull()
    expect(log.tailSince(4)).toBe("bbbbcccc")
    expect(log.version).toBe(12)
  })
})
