import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { dataRoot, fingerprint, type ServerMode } from "./server-mode"

/**
 * The app's side of the CLI's single-instance lock
 * (src/server/instance-socket.ts): the process that runs Kanna holds a Unix
 * socket at `<data root>/kanna.sock` and answers on it. The app asks it for
 * the server's port, whatever port that is and mid-update-restart included,
 * and for who started it, which decides what quitting the app does. A
 * `kanna` from before the lock has no socket; the app then falls back to
 * checking /health on the default port.
 */

export interface InstanceStatus {
  pid: number
  instance: string
  owner: "terminal" | "app" | "background"
  port: number | null
  runningChats: number | null
  cloud: boolean | null
}

/** Mirrors instanceSocketPath() in src/server/instance-socket.ts. */
export function socketPath(mode: ServerMode) {
  const root = dataRoot(mode)
  const print = fingerprint(mode)
  if (!root || !print) return null
  const inRoot = path.join(root, "kanna.sock")
  return Buffer.byteLength(inRoot) < 100 ? inRoot : path.join(os.tmpdir(), `kanna-${print}.sock`)
}

type Request = { type: "status" } | { type: "release" } | { type: "stop" }

function ask(socket: string, request: Request, timeoutMs = 1_000) {
  return new Promise<Record<string, unknown> | null>((resolve) => {
    if (!fs.existsSync(socket)) {
      resolve(null)
      return
    }
    let buffer = ""
    let settled = false
    const connection = net.createConnection(socket)
    const finish = (answer: Record<string, unknown> | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connection.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    connection.on("error", () => finish(null))
    connection.once("connect", () => connection.write(`${JSON.stringify(request)}\n`))
    connection.setEncoding("utf8")
    connection.on("data", (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      try {
        finish(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      } catch {
        finish(null)
      }
    })
  })
}

/** The Kanna serving this mode's data dir, or null when none is running
 *  (or it's a `kanna` from before the lock). */
export async function instanceStatus(mode: ServerMode): Promise<InstanceStatus | null> {
  const socket = socketPath(mode)
  if (!socket) return null
  const answer = await ask(socket, { type: "status" })
  if (answer?.ok !== true || typeof answer.pid !== "number" || answer.instance !== fingerprint(mode)) return null
  return {
    pid: answer.pid,
    instance: answer.instance as string,
    owner: answer.owner === "app" || answer.owner === "background" ? answer.owner : "terminal",
    port: typeof answer.port === "number" ? answer.port : null,
    runningChats: typeof answer.runningChats === "number" ? answer.runningChats : null,
    cloud: typeof answer.cloud === "boolean" ? answer.cloud : null,
  }
}

/** Keep the server running after the app quits. */
export async function releaseInstance(mode: ServerMode) {
  const socket = socketPath(mode)
  const answer = socket ? await ask(socket, { type: "release" }) : null
  return answer?.owner === "background"
}

/** Ask the server to stop, as `kanna stop` does. */
export async function stopInstance(mode: ServerMode) {
  const socket = socketPath(mode)
  const answer = socket ? await ask(socket, { type: "stop" }, 2_000) : null
  return answer?.ok === true
}
