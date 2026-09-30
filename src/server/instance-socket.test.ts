import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  acquireInstanceLock,
  attachToSupervisor,
  instanceSocketPath,
  instanceStatus,
  requestInstanceStop,
  startsServer,
  type InstanceLock,
} from "./instance-socket"

// Short: macOS caps a socket path at 104 bytes.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-"))
let count = 0
const locks: InstanceLock[] = []

function socketPath() {
  return path.join(dir, `${++count}.sock`)
}

async function acquire(socket: string, owner: "terminal" | "app" = "terminal", onStop = () => {}) {
  const lock = await acquireInstanceLock({ owner, onStop, socketPath: socket })
  if (lock) locks.push(lock)
  return lock
}

async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 2_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out")
    await Bun.sleep(20)
  }
}

afterEach(() => {
  for (const lock of locks.splice(0)) lock.close()
})

describe("the instance lock", () => {
  test("one holder at a time; the second finds the first", async () => {
    const socket = socketPath()
    const first = await acquire(socket)
    expect(first).not.toBeNull()
    expect(await acquire(socket)).toBeNull()

    const status = await instanceStatus({ socketPath: socket })
    expect(status).toMatchObject({ ok: true, pid: process.pid, owner: "terminal", port: null })
  })

  test("the server reports its port and state once it listens", async () => {
    const socket = socketPath()
    const lock = (await acquire(socket))!
    lock.attach({ port: 4123, version: "1.2.3", state: () => ({ runningChats: 2, cloud: true }) })
    expect(await instanceStatus({ socketPath: socket })).toMatchObject({
      port: 4123,
      version: "1.2.3",
      runningChats: 2,
      cloud: true,
    })
  })

  test("a socket left by a crashed Kanna is taken over", async () => {
    const socket = socketPath()
    // A regular file is what a dead process leaves behind as far as
    // connecting goes: nobody accepts.
    fs.writeFileSync(socket, "")
    expect(await instanceStatus({ socketPath: socket })).toBeNull()
    expect(await acquire(socket)).not.toBeNull()
  })

  test("release keeps the app's server running, and not a terminal's", async () => {
    const appSocket = socketPath()
    const appLock = (await acquire(appSocket, "app"))!
    expect(appLock.releasedFromParent).toBe(false)
    await release(appSocket)
    expect(appLock.owner).toBe("background")
    expect(appLock.releasedFromParent).toBe(true)

    const terminalSocket = socketPath()
    const terminalLock = (await acquire(terminalSocket, "terminal"))!
    await release(terminalSocket)
    expect(terminalLock.owner).toBe("terminal")
  })

  test("stop reaches the holder", async () => {
    const socket = socketPath()
    let stopped = false
    await acquire(socket, "terminal", () => {
      stopped = true
    })
    expect(await requestInstanceStop({ socketPath: socket })).toBe(true)
    expect(stopped).toBe(true)
    expect(await requestInstanceStop({ socketPath: socketPath() })).toBe(false)
  })

  test("a server child attaches to its supervisor, and detaches when it exits", async () => {
    const socket = socketPath()
    await acquire(socket)
    let runningChats = 1
    const detach = attachToSupervisor(
      { port: 5000, version: "9.9.9", state: () => ({ runningChats, cloud: false }) },
      { socketPath: socket },
    )
    await until(async () => (await instanceStatus({ socketPath: socket }))?.runningChats === 1)
    expect(await instanceStatus({ socketPath: socket })).toMatchObject({ port: 5000, version: "9.9.9" })

    runningChats = 3
    await until(async () => (await instanceStatus({ socketPath: socket }))?.runningChats === 3)

    detach()
    await until(async () => (await instanceStatus({ socketPath: socket }))?.port === null)
  })

  test("close removes the socket", async () => {
    const socket = socketPath()
    const lock = (await acquire(socket))!
    locks.pop()
    lock.close()
    expect(fs.existsSync(socket)).toBe(false)
    expect(await instanceStatus({ socketPath: socket })).toBeNull()
  })
})

describe("instanceSocketPath", () => {
  test("sits in the data root, or the temp dir for a long home folder", () => {
    expect(instanceSocketPath("/Users/jake", "darwin")).toMatch(/^\/Users\/jake\/\.kanna(-dev)?\/kanna\.sock$/)
    const long = `/Users/${"x".repeat(120)}`
    expect(instanceSocketPath(long, "darwin")).toMatch(/kanna-[0-9a-f]{16}\.sock$/)
    expect(instanceSocketPath("/Users/jake", "win32")).toMatch(/^\\\\\.\\pipe\\kanna-[0-9a-f]{16}$/)
  })
})

describe("startsServer", () => {
  test("a run needs the lock; commands and pair don't", () => {
    expect(startsServer([])).toBe(true)
    expect(startsServer(["--port", "4000", "--no-open"])).toBe(true)
    expect(startsServer(["--version"])).toBe(false)
    expect(startsServer(["--help"])).toBe(false)
    expect(startsServer(["stop"])).toBe(false)
    expect(startsServer(["slim-transcripts"])).toBe(false)
    expect(startsServer(["pair", "ABC123"])).toBe(false)
  })
})

async function release(socket: string) {
  const net = await import("node:net")
  await new Promise<void>((resolve) => {
    const client = net.createConnection(socket, () => client.write(`${JSON.stringify({ type: "release" })}\n`))
    client.on("data", () => {
      client.destroy()
      resolve()
    })
  })
}
