import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import type { IncomingHttpHeaders } from "node:http"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { generateRemoteWorkspaceFiles, initializeRemoteWorkspace } from "./remote-workspace-lib"

const timeoutMs = 30_000
const outputLimit = 4 * 1024 * 1024

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; input?: string } = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? timeoutMs,
    maxBuffer: outputLimit,
    input: options.input,
  })
  if (result.error) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").slice(-40).join("\n")
    throw new Error(`${command} could not run: ${result.error.message}${output ? `\n${output}` : ""}`)
  }
  if (result.status !== 0) {
    let detail = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split("\n").slice(-40).join("\n")
    if (command === "mutagen" && args[0] === "sync" && args[1] !== "list" && args.length >= 3) {
      const session = args[args.length - 1]!
      const status = spawnSync(command, ["sync", "list", "--long", session], {
        env: options.env ?? process.env,
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: outputLimit,
      })
      if (status.status === 0) detail = `${detail}\nSession status:\n${status.stdout.trim().slice(0, 3_000)}`
    }
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}${detail ? `:\n${detail}` : ""}`)
  }
  return result.stdout
}

function commandExists(name: string) {
  const result = spawnSync("which", [name], { stdio: "ignore" })
  return result.error === undefined && result.status === 0
}

async function waitForMutagenReady(session: string, env: NodeJS.ProcessEnv, label: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = ""
  while (Date.now() < deadline) {
    lastStatus = run("mutagen", ["sync", "list", "--long", session], { env })
    if (!/Synchronization mode:\s*Two Way Safe/i.test(lastStatus)) {
      throw new Error(`${label}: session is not configured for Two Way Safe: ${lastStatus.slice(0, 1_000)}`)
    }
    if (/Status:\s*\[Paused\]/i.test(lastStatus)) throw new Error(`${label}: Mutagen session unexpectedly paused: ${lastStatus.slice(0, 1_000)}`)
    const connectedEndpoints = (lastStatus.match(/Connected:\s*Yes/gi) ?? []).length
    const hasConflicts = /(?:^|\n)Conflicts:\s*\n\s*\((?:alpha|beta)\)\s+/i.test(lastStatus)
    if (connectedEndpoints >= 2 && !hasConflicts) return lastStatus
    await Bun.sleep(250)
  }
  throw new Error(`${label}: Mutagen session did not become connected and conflict-free: ${lastStatus.slice(0, 3_000)}`)
}

async function flushMutagen(session: string, env: NodeJS.ProcessEnv, label: string) {
  await waitForMutagenReady(session, env, label)
  run("mutagen", ["sync", "flush", session], { env, timeout: 60_000 })
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(value, "utf8")) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return hash.toString(16).padStart(16, "0")
}

function sshAlias(host: string, port: number) {
  const slug = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "host"
  return `kanna-${slug}-${fnv1a64(host)}-${port}`
}

async function unusedPort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Unable to allocate a local SSH port")
  const port = address.port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function assertEqual(actual: string, expected: string, label: string) {
  if (actual.trim() !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual.trim())}`)
}

function assertExact(actual: string, expected: string, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`)
}

function hostedHttpsRequest(args: {
  host: string
  ca: string
  path: string
  method: string
  port: number
  headers?: Record<string, string>
  body?: string
}) {
  const nodeClient = String.raw`const https=require("https");let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const a=JSON.parse(input);const safe=x=>String(x||"").replace(/[\r\n\t]+/g," ").slice(0,240);const r=https.request({hostname:"127.0.0.1",port:a.port,servername:a.host,path:a.path,method:a.method,ca:a.ca,headers:{Host:a.host+":"+a.port,...a.headers},rejectUnauthorized:true},s=>{const c=[];s.on("data",x=>c.push(x));s.on("end",()=>process.stdout.write(JSON.stringify({status:s.statusCode||0,headers:s.headers,body:Buffer.concat(c).toString("utf8")})))});r.on("upgrade",(s,socket)=>{socket.destroy();process.stdout.write(JSON.stringify({status:s.statusCode||0,headers:s.headers,body:""}))});r.on("error",e=>process.stdout.write(JSON.stringify({error:{code:e.code||"unknown",errno:e.errno||"unknown",address:e.address||"unknown",port:e.port||"unknown",message:safe(e.message),reason:safe(e.reason),library:safe(e.library)}})));if(a.body)r.write(a.body);r.end()})`
  const result = spawnSync("node", ["-e", nodeClient], {
    env: process.env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: outputLimit,
    input: JSON.stringify({ host: args.host, ca: args.ca, path: args.path, method: args.method, port: args.port, headers: args.headers, body: args.body }),
  })
  if (result.error) throw new Error(`Node HTTPS helper failed (${(result.error as NodeJS.ErrnoException).code ?? "unknown"})`)
  if (result.status !== 0) throw new Error(`Node HTTPS helper exited with status ${result.status ?? "unknown"}`)
  const parsed = JSON.parse(result.stdout) as { status?: number; headers?: IncomingHttpHeaders; body?: string; error?: { code?: string; errno?: string; address?: string; port?: string; message?: string; reason?: string; library?: string } }
  if (parsed.error) {
    const detail = [parsed.error.message, parsed.error.reason, parsed.error.library].filter(Boolean).join(" | ")
    throw new Error(`Node HTTPS request failed (code=${parsed.error.code} errno=${parsed.error.errno} address=${parsed.error.address} port=${parsed.error.port}${detail ? ` detail=${detail}` : ""})`)
  }
  return { status: parsed.status ?? 0, headers: parsed.headers ?? {}, body: parsed.body ?? "" }
}

function diagnoseStrictHttpsHealth(args: { host: string; port: number; caPath: string }) {
  const resolve = `${args.host}:${args.port}:127.0.0.1`
  const curl = spawnSync("curl", [
    "--silent", "--show-error", "--max-time", "5", "--output", "/dev/null",
    "--write-out", "%{http_code}", "--resolve", resolve, "--cacert", args.caPath,
    `https://${args.host}:${args.port}/health`,
  ], { env, encoding: "utf8", timeout: 6_000, maxBuffer: 1024 })
  const curlCategory = curl.error
    ? `spawn-${(curl.error as NodeJS.ErrnoException).code ?? "unknown"}`
    : curl.status === 0 && /^\d{3}$/.test(curl.stdout.trim())
      ? `HTTP-${curl.stdout.trim()}`
      : `curl-exit-${curl.status ?? "unknown"}-code-${/curl:\s*\((\d+)\)/.exec(curl.stderr ?? "")?.[1] ?? "unknown"}`

  const port = spawnSync("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "port", "caddy", "443"], {
    cwd: outputDir, env, encoding: "utf8", timeout: 5_000, maxBuffer: 1024,
  })
  const portBinding = port.status === 0 && /^127\.0\.0\.1:\d+$/.test(port.stdout.trim())
    ? port.stdout.trim()
    : `unavailable-${port.error ? (port.error as NodeJS.ErrnoException).code ?? "spawn-error" : `exit-${port.status ?? "unknown"}`}`

  const states = (["caddy", "kanna_alice", "kanna_bob"] as const).map((service) => {
    const ids = spawnSync("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "ps", "--all", "--quiet", service], {
      cwd: outputDir, env, encoding: "utf8", timeout: 5_000, maxBuffer: 1024,
    })
    const id = ids.status === 0 ? ids.stdout.trim().split("\n").filter(Boolean)[0] : undefined
    if (!id) return `${service}=missing`
    const inspect = spawnSync("docker", ["inspect", "--format", "{{.State.Status}} {{.RestartCount}}", id], {
      env, encoding: "utf8", timeout: 5_000, maxBuffer: 1024,
    })
    const match = inspect.status === 0 ? /^(\S+)\s+(\d+)$/.exec(inspect.stdout.trim()) : null
    return match ? `${service}=state:${match[1]},restarts:${match[2]}` : `${service}=inspect-unavailable`
  })
  return `strict-curl=${curlCategory}; caddy443=${portBinding}; containers=${states.join(";")}`
}

async function websocketUpgrade(host: string, origin: string, cookie: string, ca: string, port: number) {
  const response = await hostedHttpsRequest({
    host, ca, port, path: "/ws", method: "GET",
    headers: {
      Origin: origin,
      Cookie: cookie,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    },
  })
  return response.status
}

interface AppWebSocket {
  send: (value: string) => void
  close: () => void
  diagnostics: () => Array<Record<string, unknown>>
}

function openAuthenticatedWebSocket(host: string, origin: string, cookie: string, ca: string, port: number) {
  const nodeWebSocket = String.raw`const WebSocket=require("ws"),readline=require("readline");let socket,started=false;const out=x=>process.stdout.write(JSON.stringify(x)+"\n");readline.createInterface({input:process.stdin}).on("line",line=>{try{const a=JSON.parse(line);if(!started){started=true;socket=new WebSocket("wss://127.0.0.1:"+a.port+"/ws",{ca:a.ca,rejectUnauthorized:true,servername:a.host,headers:{Host:a.host+":"+a.port,Origin:a.origin,Cookie:a.cookie}});socket.on("open",()=>out({type:"upgrade",status:101}));socket.on("message",data=>out({type:"message",payload:data.toString()}));socket.on("unexpected-response",(req,res)=>{res.resume();out({type:"response",status:res.statusCode||0})});socket.on("error",e=>out({type:"error",code:e.code||"unknown"}))}else if(a.type==="send"&&socket&&socket.readyState===WebSocket.OPEN)socket.send(a.value);else if(a.type==="close"&&socket){socket.close();setTimeout(()=>process.exit(0),250)}}catch(e){out({type:"error",code:"client_error"})}})`
  return new Promise<{ socket: AppWebSocket; waitFor: (predicate: (value: Record<string, unknown>) => boolean, label: string, timeoutMs?: number) => Promise<Record<string, unknown>> }>((resolve, reject) => {
    const child = spawn("node", ["-e", nodeWebSocket], { cwd: process.cwd(), stdio: ["pipe", "pipe", "ignore"] })
    const messages: Record<string, unknown>[] = []
    const waiters: Array<() => void> = []
    const receivedMetadata: Array<Record<string, unknown>> = []
    let lineBuffer = ""
    let upgradeSettled = false
    let resolveUpgrade!: () => void
    let rejectUpgrade!: (error: Error) => void
    const upgrade = new Promise<void>((yes, no) => { resolveUpgrade = yes; rejectUpgrade = no })
    const dispatch = (event: Record<string, unknown>) => {
      if (event.type === "upgrade") {
        if (event.status !== 101) rejectUpgrade(new Error(`Authenticated Kanna WebSocket rejected with HTTP ${String(event.status)}`))
        else resolveUpgrade()
        upgradeSettled = true
      } else if (event.type === "response") {
        rejectUpgrade(new Error(`Authenticated Kanna WebSocket rejected with HTTP ${String(event.status)}`))
        upgradeSettled = true
      } else if (event.type === "error" && !upgradeSettled) {
        rejectUpgrade(new Error(`Authenticated Kanna WebSocket transport failed (${String(event.code)})`))
        upgradeSettled = true
      } else if (event.type === "message") {
        try {
          const message = JSON.parse(String(event.payload)) as Record<string, unknown>
          const eventBody = message.event as { type?: string; terminalId?: string } | undefined
          receivedMetadata.push({
            type: message.type,
            id: message.id,
            eventType: eventBody?.type,
            eventTerminalId: eventBody?.terminalId,
            snapshotType: (message.snapshot as { type?: string } | undefined)?.type,
          })
          if (receivedMetadata.length > 40) receivedMetadata.shift()
          messages.push(message)
        } catch {}
        for (const wake of waiters.splice(0)) wake()
      }
    }
    child.stdout.on("data", (chunk: Buffer) => {
      lineBuffer += chunk.toString("utf8")
      const lines = lineBuffer.split("\n")
      lineBuffer = lines.pop() ?? ""
      for (const line of lines) {
        try { dispatch(JSON.parse(line) as Record<string, unknown>) } catch {}
      }
    })
    child.once("error", (error) => { if (!upgradeSettled) { rejectUpgrade(new Error(`Node WebSocket helper failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`)); upgradeSettled = true } })
    child.stdin.write(`${JSON.stringify({ host, origin, cookie, ca, port })}\n`)
    const socket: AppWebSocket = {
      send: (value) => { child.stdin.write(`${JSON.stringify({ type: "send", value })}\n`) },
      close: () => { child.stdin.write(`${JSON.stringify({ type: "close" })}\n`); child.stdin.end(); setTimeout(() => child.kill("SIGTERM"), 1_000).unref() },
      diagnostics: () => receivedMetadata.slice(),
    }
    void upgrade.then(() => {
      const waitFor = async (predicate: (value: Record<string, unknown>) => boolean, label: string, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const index = messages.findIndex(predicate)
          if (index >= 0) return messages.splice(index, 1)[0]!
          await new Promise<void>((wake) => {
            const timer = setTimeout(() => wake(), Math.max(1, deadline - Date.now()))
            waiters.push(() => { clearTimeout(timer); wake() })
          })
        }
        const received = messages.slice(-8).map((message) => ({
          type: message.type,
          id: message.id,
          eventType: (message.event as { type?: string } | undefined)?.type,
          eventTerminalId: (message.event as { terminalId?: string } | undefined)?.terminalId,
        }))
        throw new Error(`Timed out waiting for Kanna WebSocket ${label}; queuedMessages=${JSON.stringify(received)}`)
      }
      resolve({ socket, waitFor })
    }).catch(reject)
  })
}

function wsCommand(socket: AppWebSocket, id: string, command: Record<string, unknown>) {
  socket.send(JSON.stringify({ v: 1, type: "command", id, command }))
}

function printfLine(value: string, leadingNewline = false) {
  const splitAt = Math.max(1, Math.floor(value.length / 2))
  return `printf '${leadingNewline ? "\\n" : ""}%s%s\\n' '${value.slice(0, splitAt)}' '${value.slice(splitAt)}'`
}

async function runPtyCheck(
  socket: AppWebSocket,
  waitFor: (predicate: (value: Record<string, unknown>) => boolean, label: string, timeoutMs?: number) => Promise<Record<string, unknown>>,
  projectId: string,
  localPath: string,
  suffix: string,
  commandData: string,
  doneToken: string,
  expectedOutput?: string
) {
  const terminalId = `remote-workspace-e2e-${suffix}`
  const ackId = `${terminalId}-create`
  const subscriptionId = `${terminalId}-subscription`
  wsCommand(socket, ackId, { type: "terminal.create", projectId, terminalId, cols: 80, rows: 24, scrollback: 1_000 })
  const created = await waitFor((message) => message.type === "ack" && message.id === ackId, `${terminalId} create ack`)
  const snapshot = created.result as { cwd?: string; status?: string } | undefined
  assertEqual(snapshot?.cwd ?? "", localPath, `${terminalId} PTY cwd`)
  assertEqual(snapshot?.status ?? "", "running", `${terminalId} PTY status`)
  socket.send(JSON.stringify({ v: 1, type: "subscribe", id: subscriptionId, topic: { type: "terminal", terminalId } }))
  await waitFor((message) => message.type === "snapshot" && message.id === subscriptionId, `${terminalId} initial snapshot`)
  const inputId = `${terminalId}-input`
  wsCommand(socket, inputId, { type: "terminal.input", terminalId, data: commandData })
  await waitFor((message) => message.type === "ack" && message.id === inputId, `${terminalId} input ack`)
  let output = ""
  const hasDoneLine = () => output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/[\r\n]+/)
    .some((line) => line.trim() === doneToken)
  while (!hasDoneLine()) {
    try {
      const envelope = await waitFor((message) => {
        if (message.type !== "event" || message.id !== subscriptionId) return false
        const event = message.event as { type?: string; terminalId?: string } | undefined
        return event?.type === "terminal.output" && event.terminalId === terminalId
      }, `${terminalId} output`)
      const event = envelope.event as { data?: string }
      output += event.data ?? ""
    } catch (error) {
      const tailId = `${terminalId}-failure-tail`
      wsCommand(socket, tailId, { type: "terminal.tail", terminalId, sinceVersion: null })
      const tailAck = await waitFor((message) => message.type === "ack" && message.id === tailId, `${terminalId} failure tail`)
      const tailResult = tailAck.result as { tail?: { data?: string } | null; snapshot?: { serializedState?: string } | null } | undefined
      const serverTail = tailResult?.tail?.data ?? tailResult?.snapshot?.serializedState ?? ""
      throw new Error(`${error instanceof Error ? error.message : "PTY output wait failed"}; serverTail=${JSON.stringify(redactLogText(serverTail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-800)))}; wsMessages=${JSON.stringify(socket.diagnostics().slice(-15))}`)
    }
  }
  if (!output.includes(localPath)) {
    const safeTail = redactLogText(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").slice(-800))
    throw new Error(`${terminalId} PTY output did not include its pwd directory; outputTail=${JSON.stringify(safeTail)}`)
  }
  if (expectedOutput && !output.includes(expectedOutput)) throw new Error(`${terminalId} PTY output did not include the expected command output`)
  const closeId = `${terminalId}-close`
  wsCommand(socket, closeId, { type: "terminal.close", terminalId })
  await waitFor((message) => message.type === "ack" && message.id === closeId, `${terminalId} close ack`)
}

async function runPtyInterruptSmoke(
  socket: AppWebSocket,
  waitFor: (predicate: (value: Record<string, unknown>) => boolean, label: string, timeoutMs?: number) => Promise<Record<string, unknown>>,
  projectId: string,
  localPath: string,
  bobShellProcess: ContainerProcess
) {
  const terminalId = "remote-workspace-e2e-ctrl-c"
  const createId = `${terminalId}-create`
  wsCommand(socket, createId, { type: "terminal.create", projectId, terminalId, cols: 80, rows: 24, scrollback: 1_000 })
  const created = await waitFor((message) => message.type === "ack" && message.id === createId, `${terminalId} create ack`)
  const snapshot = created.result as { cwd?: string; status?: string } | undefined
  assertEqual(snapshot?.cwd ?? "", localPath, `${terminalId} PTY cwd`)
  assertEqual(snapshot?.status ?? "", "running", `${terminalId} PTY status`)
  const subscriptionId = `${terminalId}-subscription`
  socket.send(JSON.stringify({ v: 1, type: "subscribe", id: subscriptionId, topic: { type: "terminal", terminalId } }))
  await waitFor((message) => message.type === "snapshot" && message.id === subscriptionId, `${terminalId} initial snapshot`)
  const output: string[] = []
  const readOutput = async (label: string, timeoutMs: number) => {
    const envelope = await waitFor((message) => {
      if (message.type !== "event" || message.id !== subscriptionId) return false
      const event = message.event as { type?: string; terminalId?: string } | undefined
      return event?.type === "terminal.output" && event.terminalId === terminalId
    }, label, timeoutMs)
    const event = envelope.event as { data?: string }
    output.push(event.data ?? "")
  }
  const cleanOutput = () => output.join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  const waitForMarker = async (marker: string, label: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (cleanOutput().split(/[\r\n]+/).some((line) => line.trim() === marker)) return
      await readOutput(label, deadline - Date.now())
    }
    throw new Error(`${label} did not arrive within ${timeoutMs}ms`)
  }
  const input = async (id: string, data: string, label: string) => {
    wsCommand(socket, id, { type: "terminal.input", terminalId, data })
    await waitFor((message) => message.type === "ack" && message.id === id, label)
  }
  output.length = 0
  await input(`${terminalId}-shell-pid`, `printf '\\n%s%s shell=%s\\n' '__E2E_PRIMARY_' 'SHELL' "$$"\r`, `${terminalId} shell PID input ack`)
  let primaryShellPid: number | undefined
  const primaryPidDeadline = Date.now() + 5_000
  while (primaryShellPid === undefined && Date.now() < primaryPidDeadline) {
    await readOutput(`${terminalId} shell PID line`, primaryPidDeadline - Date.now())
    const line = cleanOutput().split(/[\r\n]+/).map((value) => value.trim()).find((value) => value.startsWith("__E2E_PRIMARY_SHELL shell="))
    const match = line?.match(/^__E2E_PRIMARY_SHELL shell=(\d+)$/)
    if (match) primaryShellPid = Number(match[1])
  }
  if (primaryShellPid === undefined) throw new Error(`${terminalId} did not report its shell PID`)
  const primaryShellProcess = assertContainerProcessLive("alice", primaryShellPid, "$shell", `${terminalId} shell`)
  const interruptForegroundJob = async (command: string, readyPrefixes: string[], expectedCommands: string[], marker: string, label: string) => {
    output.length = 0
    await input(`${terminalId}-${label}-start`, `${command}\r`, `${label} input ack`)
    const processPids = new Map<string, number>()
    const readyDeadline = Date.now() + 5_000
    while (processPids.size < readyPrefixes.length && Date.now() < readyDeadline) {
      for (const line of cleanOutput().split(/[\r\n]+/).map((value) => value.trim())) {
        for (const prefix of readyPrefixes) {
          const match = line.match(new RegExp(`^${prefix}READY child=(\\d+)$`))
          if (match) processPids.set(prefix, Number(match[1]))
        }
      }
      if (processPids.size < readyPrefixes.length) await readOutput(`${label} complete READY line`, readyDeadline - Date.now())
    }
    if (processPids.size !== readyPrefixes.length) throw new Error(`${label} did not emit all complete READY lines before Ctrl-C`)
    const liveProcesses = readyPrefixes.map((prefix, index) =>
      assertContainerProcessLive("alice", processPids.get(prefix)!, expectedCommands[index]!, label))
    const startedAt = Date.now()
    await input(`${terminalId}-${label}-interrupt`, "\u0003", `${label} Ctrl-C ack`)
    await input(`${terminalId}-${label}-marker`, `${printfLine(marker, true)}\r`, `${label} marker input ack`)
    await waitForMarker(marker, `${label} shell marker`, 3_000)
    const elapsedMs = Date.now() - startedAt
    if (elapsedMs > 3_000) throw new Error(`${label} Ctrl-C returned to the shell after ${elapsedMs}ms`)
    for (const [index, processInfo] of liveProcesses.entries()) {
      await waitForContainerProcessGone("alice", processInfo, `${label} child ${index + 1}`)
    }
    const shellStillAlive = inspectContainerProcess("alice", primaryShellPid!)
    assertEqual(shellStillAlive?.startTime ?? "", primaryShellProcess.startTime, `${label} leaves the interactive shell running`)
    diagnosticFacts.push(`${label} PTY Ctrl-C: child PID(s) ${liveProcesses.map((item) => `${item.pid}(state=${item.state},pgid=${item.processGroup},sid=${item.sessionId},start=${item.startTime})`).join(",")} were live before input and gone after shell marker; shell PID ${primaryShellPid} start=${primaryShellProcess.startTime} survived`)
  }
  const otherTerminalId = `${terminalId}-neighbor`
  let activeCloseTerminalId: string | null = null
  try {
    const otherCreateId = `${otherTerminalId}-create`
    wsCommand(socket, otherCreateId, { type: "terminal.create", projectId, terminalId: otherTerminalId, cols: 80, rows: 24, scrollback: 1_000 })
    const otherCreated = await waitFor((message) => message.type === "ack" && message.id === otherCreateId, `${otherTerminalId} create ack`)
    assertEqual((otherCreated.result as { status?: string } | undefined)?.status ?? "", "running", `${otherTerminalId} initial status`)
    const otherSubscriptionId = `${otherTerminalId}-subscription`
    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: otherSubscriptionId, topic: { type: "terminal", terminalId: otherTerminalId } }))
    await waitFor((message) => message.type === "snapshot" && message.id === otherSubscriptionId, `${otherTerminalId} initial snapshot`)

    const otherMarker = "K_E2E_NEIGHBOR_DONE"
    let otherOutput = ""
    const otherInputId = `${otherTerminalId}-delayed-marker`
    wsCommand(socket, otherInputId, { type: "terminal.input", terminalId: otherTerminalId, data: `printf '\\n%s%s shell=%s\\n' '__E2E_NEIGHBOR_' 'SHELL' "$$"; sleep 2; ${printfLine(otherMarker, true)}\r` })
    await waitFor((message) => message.type === "ack" && message.id === otherInputId, `${otherTerminalId} delayed command ack`)
    let otherShellPid: number | undefined
    const otherReadyDeadline = Date.now() + 5_000
    while (otherShellPid === undefined && Date.now() < otherReadyDeadline) {
      const message = await waitFor((value) => {
        if (value.type !== "event" || value.id !== otherSubscriptionId) return false
        const event = value.event as { type?: string; terminalId?: string } | undefined
        return event?.type === "terminal.output" && event.terminalId === otherTerminalId
      }, `${otherTerminalId} shell PID`, otherReadyDeadline - Date.now())
      const event = message.event as { data?: string }
      otherOutput += event.data ?? ""
      const line = otherOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/).map((value) => value.trim()).find((value) => value.startsWith("__E2E_NEIGHBOR_SHELL shell="))
      const match = line?.match(/^__E2E_NEIGHBOR_SHELL shell=(\d+)$/)
      if (match) otherShellPid = Number(match[1])
    }
    if (otherShellPid === undefined) throw new Error(`${otherTerminalId} did not report its shell PID`)
    const otherShellProcess = assertContainerProcessLive("alice", otherShellPid, "$shell", `${otherTerminalId} shell`)

    const ptySleepCommand = (prefix: string) => `sh -c ${shellQuote(`printf '\\n%s%s child=%s\\n' '${prefix}' 'READY' "$$"; exec sleep 30`)}`
    await interruptForegroundJob(ptySleepCommand("__E2E_SLEEP_"), ["__E2E_SLEEP_"], ["sleep"], "K_E2E_CTRL_C_DONE", "sleep")
    const otherDeadline = Date.now() + 5_000
    while (Date.now() < otherDeadline) {
      const queued = await waitFor((message) => {
        if (message.type !== "event" || message.id !== otherSubscriptionId) return false
        const event = message.event as { type?: string; terminalId?: string } | undefined
        return event?.type === "terminal.output" && event.terminalId === otherTerminalId
      }, `${otherTerminalId} delayed output`, otherDeadline - Date.now())
      const event = queued.event as { data?: string }
      otherOutput += event.data ?? ""
      if (otherOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/).some((line) => line.trim() === otherMarker)) break
    }
    if (!otherOutput.includes(otherMarker)) throw new Error(`${otherTerminalId} stopped producing output during the foreground Ctrl-C test`)
    const otherTailId = `${otherTerminalId}-status`
    wsCommand(socket, otherTailId, { type: "terminal.tail", terminalId: otherTerminalId, sinceVersion: null })
    const otherTail = await waitFor((message) => message.type === "ack" && message.id === otherTailId, `${otherTerminalId} status tail`)
    assertEqual((otherTail.result as { snapshot?: { status?: string } } | undefined)?.snapshot?.status ?? "", "running", `${otherTerminalId} remains alive`)

    const pipelineCommand = `${ptySleepCommand("__E2E_PIPE_SLEEP_")} | sh -c ${shellQuote(`printf '\\n%s%s child=%s\\n' '__E2E_PIPE_CAT_' 'READY' "$$"; exec cat`)}`
    await interruptForegroundJob(pipelineCommand, ["__E2E_PIPE_SLEEP_", "__E2E_PIPE_CAT_"], ["sleep", "cat"], "K_E2E_PIPELINE_DONE", "pipeline")
    const neighborAfterCtrlC = inspectContainerProcess("alice", otherShellPid)
    assertEqual(neighborAfterCtrlC?.startTime ?? "", otherShellProcess.startTime, `${otherTerminalId} survives Ctrl-C`)

    output.length = 0
    const rawCommand = "stty raw -echo; printf '__K_E2E_RAW_READY__\\n'; dd bs=1 count=1 2>/dev/null | od -An -tu1; stty sane; printf '%s%s\\n' '__K_E2E_RAW_' 'DONE'\r"
    await input(`${terminalId}-raw-start`, rawCommand, `${terminalId} raw command ack`)
    await waitForMarker("__K_E2E_RAW_READY__", `${terminalId} raw-ready line`, 5_000)
    await input(`${terminalId}-raw-byte`, "\u0003", `${terminalId} raw Ctrl-C ack`)
    await waitForMarker("__K_E2E_RAW_DONE", `${terminalId} raw byte completion`, 5_000)
    if (!cleanOutput().split(/[\r\n]+/).some((line) => line.trim() === "3")) throw new Error("PTY raw mode did not deliver Ctrl-C as byte 3")

    const resizeId = `${terminalId}-resize`
    wsCommand(socket, resizeId, { type: "terminal.resize", terminalId, cols: 95, rows: 37 })
    await waitFor((message) => message.type === "ack" && message.id === resizeId, `${terminalId} resize ack`)
    output.length = 0
    await input(`${terminalId}-stty-size`, `stty size; ${printfLine("K_E2E_RESIZE_DONE", true)}\r`, `${terminalId} resized dimensions input ack`)
    await waitForMarker("K_E2E_RESIZE_DONE", `${terminalId} resized dimensions marker`, 5_000)
    if (!cleanOutput().split(/[\r\n]+/).some((line) => line.trim() === "37 95")) throw new Error("PTY resize did not reach the shell as 37 rows by 95 columns")

    const closeTerminalId = `${terminalId}-close-active-job`
    activeCloseTerminalId = closeTerminalId
    wsCommand(socket, `${closeTerminalId}-create`, { type: "terminal.create", projectId, terminalId: closeTerminalId, cols: 80, rows: 24, scrollback: 1_000 })
    await waitFor((message) => message.type === "ack" && message.id === `${closeTerminalId}-create`, `${closeTerminalId} create ack`)
    socket.send(JSON.stringify({ v: 1, type: "subscribe", id: `${closeTerminalId}-subscription`, topic: { type: "terminal", terminalId: closeTerminalId } }))
    await waitFor((message) => message.type === "snapshot" && message.id === `${closeTerminalId}-subscription`, `${closeTerminalId} initial snapshot`)
    const closeOutput: string[] = []
    const closeReadOutput = async (timeoutMs: number) => {
      const message = await waitFor((value) => {
        if (value.type !== "event" || value.id !== `${closeTerminalId}-subscription`) return false
        const event = value.event as { type?: string; terminalId?: string } | undefined
        return event?.type === "terminal.output" && event.terminalId === closeTerminalId
      }, `${closeTerminalId} output`, timeoutMs)
      closeOutput.push((message.event as { data?: string }).data ?? "")
    }
    wsCommand(socket, `${closeTerminalId}-shell-pid`, { type: "terminal.input", terminalId: closeTerminalId, data: `printf '\\n%s%s shell=%s\\n' '__E2E_CLOSE_' 'SHELL' "$$"\r` })
    await waitFor((message) => message.type === "ack" && message.id === `${closeTerminalId}-shell-pid`, `${closeTerminalId} shell PID input ack`)
    let closeShellPid: number | undefined
    const closeShellDeadline = Date.now() + 5_000
    while (closeShellPid === undefined && Date.now() < closeShellDeadline) {
      await closeReadOutput(closeShellDeadline - Date.now())
      const line = closeOutput.join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/).map((value) => value.trim()).find((value) => value.startsWith("__E2E_CLOSE_SHELL shell="))
      const match = line?.match(/^__E2E_CLOSE_SHELL shell=(\d+)$/)
      if (match) closeShellPid = Number(match[1])
    }
    if (closeShellPid === undefined) throw new Error(`${closeTerminalId} did not report its shell PID`)
    const closeShellProcess = assertContainerProcessLive("alice", closeShellPid, "$shell", `${closeTerminalId} shell`)
    closeOutput.length = 0
    wsCommand(socket, `${closeTerminalId}-job`, { type: "terminal.input", terminalId: closeTerminalId, data: `${ptySleepCommand("__E2E_CLOSE_JOB_")}\r` })
    await waitFor((message) => message.type === "ack" && message.id === `${closeTerminalId}-job`, `${closeTerminalId} active sleep input ack`)
    let closeJobPid: number | undefined
    const closeJobDeadline = Date.now() + 5_000
    while (closeJobPid === undefined && Date.now() < closeJobDeadline) {
      await closeReadOutput(closeJobDeadline - Date.now())
      const match = closeOutput.join("").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/).map((value) => value.trim())
        .map((line) => line.match(/^__E2E_CLOSE_JOB_READY child=(\d+)$/)).find(Boolean)
      if (match) closeJobPid = Number(match[1])
    }
    if (closeJobPid === undefined) throw new Error(`${closeTerminalId} active sleep did not report a complete READY line`)
    const closeJobProcess = assertContainerProcessLive("alice", closeJobPid, "sleep", `${closeTerminalId} active sleep`)
    const closeTerminalAckId = `${closeTerminalId}-close`
    wsCommand(socket, closeTerminalAckId, { type: "terminal.close", terminalId: closeTerminalId })
    await waitFor((message) => message.type === "ack" && message.id === closeTerminalAckId, `${closeTerminalId} close ack`)
    activeCloseTerminalId = null
    await waitForContainerProcessGone("alice", closeJobProcess, `${closeTerminalId} foreground sleep`)
    await waitForContainerProcessGone("alice", closeShellProcess, `${closeTerminalId} shell`)
    assertEqual(inspectContainerProcess("alice", primaryShellPid)?.startTime ?? "", primaryShellProcess.startTime, "primary shell survives neighbor close")
    assertEqual(inspectContainerProcess("alice", otherShellPid)?.startTime ?? "", otherShellProcess.startTime, "neighbor shell survives active-job close")
    assertEqual(inspectContainerProcess("bob", bobShellProcess.pid)?.startTime ?? "", bobShellProcess.startTime, "Bob shell survives Alice active-job close")
    diagnosticFacts.push(`PTY close: confirmed live shell PID ${closeShellProcess.pid} start=${closeShellProcess.startTime} and sleep PID ${closeJobProcess.pid} pgid=${closeJobProcess.processGroup} sid=${closeJobProcess.sessionId} start=${closeJobProcess.startTime}; both /proc identities disappeared after close; Alice shell PIDs ${primaryShellPid}/${otherShellPid} and Bob shell PID ${bobShellProcess.pid} retained their start times`)
  } finally {
    if (activeCloseTerminalId) {
      const closeId = `${activeCloseTerminalId}-cleanup`
      wsCommand(socket, closeId, { type: "terminal.close", terminalId: activeCloseTerminalId })
      await waitFor((message) => message.type === "ack" && message.id === closeId, `${activeCloseTerminalId} cleanup ack`).catch(() => {})
    }
    const closeId = `${terminalId}-close`
    wsCommand(socket, closeId, { type: "terminal.close", terminalId })
    await waitFor((message) => message.type === "ack" && message.id === closeId, `${terminalId} close ack`)
    const otherCloseId = `${otherTerminalId}-close`
    wsCommand(socket, otherCloseId, { type: "terminal.close", terminalId: otherTerminalId })
    await waitFor((message) => message.type === "ack" && message.id === otherCloseId, `${otherTerminalId} close ack`)
  }
  return { supported: true, reason: "sleep and pipeline interrupted within 3 seconds; raw Ctrl-C byte and resize verified; neighbor terminal survived" }
}

async function loginOnHostedApp(host: string, origin: string, password: string, ca: string, port: number) {
  return hostedHttpsRequest({
    host,
    port,
    ca,
    path: "/auth/login",
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
}

function redactLogText(value: string) {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(password|token|secret|api[_-]?key)\s*[=:]\s*\S+/gi, "$1=[REDACTED]")
}

async function codexAppServerInitialize(args: { cwd: string; env: NodeJS.ProcessEnv; composeArgs: string[] }) {
  const child = spawn("docker", args.composeArgs, { cwd: args.cwd, env: args.env, stdio: ["pipe", "pipe", "pipe"] })
  let stdoutBuffer = ""
  let stderr = ""
  let parsedLineCount = 0
  let initializeSummary = "no JSON response with id=1"
  let resolveInitialize!: (message: { result?: unknown; error?: { code?: number; message?: string } }) => void
  const initializeResponse = new Promise<{ result?: unknown; error?: { code?: number; message?: string } }>((resolve) => { resolveInitialize = resolve })
  let exitSettled = false
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => {
      exitSettled = true
      resolve({ code, signal })
    })
  })
  let spawnFailure: Error | undefined
  child.once("error", (error) => {
    spawnFailure = error
    resolveInitialize({ error: { code: -1, message: `process spawn failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})` } })
  })
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8")
    const lines = stdoutBuffer.split("\n")
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as { id?: number; result?: unknown; error?: { code?: number; message?: string } }
        parsedLineCount++
        if (parsed.id === 1 && (parsed.result !== undefined || parsed.error)) {
          initializeSummary = parsed.error
            ? `id=1 error code=${parsed.error.code ?? "unknown"} message=${redactLogText(parsed.error.message ?? "")}`
            : "id=1 result received"
          resolveInitialize(parsed)
        }
      } catch {}
    }
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000)
  })
  const cleanup = async () => {
    if (!exitSettled) {
      child.kill("SIGTERM")
      await Promise.race([exitPromise, Bun.sleep(2_000)])
      if (!exitSettled) child.kill("SIGKILL")
    }
  }
  const timeout = setTimeout(() => {
    resolveInitialize({ error: { code: -1, message: "initialize response timed out" } })
  }, 20_000)
  try {
    child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "kanna-e2e", title: "Kanna E2E", version: "0.1.0" }, capabilities: { experimentalApi: true } } })}\n`)
    const response = await Promise.race([
      initializeResponse,
      exitPromise.then(({ code, signal }) => { throw new Error(`Codex app-server exited before initialize response (exit=${code ?? "null"}, signal=${signal ?? "none"})`) }),
    ])
    if (spawnFailure) throw spawnFailure
    if (response.error || response.result === undefined) throw new Error(`Codex app-server initialize failed (${initializeSummary})`)
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`)
    child.stdin.end()
    const exit = await Promise.race([exitPromise, Bun.sleep(2_000).then(() => undefined)])
    if (exit && exit.code !== 0) throw new Error(`Codex app-server exited unexpectedly (exit=${exit.code ?? "null"}, signal=${exit.signal ?? "none"})`)
    return { summary: initializeSummary, parsedLineCount, stderr: redactLogText(stderr.slice(-600)) }
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : "Codex app-server handshake failed"}; stdoutJsonLines=${parsedLineCount}; initialize=${initializeSummary}; stderr=${redactLogText(stderr.slice(-600))}`)
  } finally {
    clearTimeout(timeout)
    await cleanup()
  }
}

const required = ["docker", "mutagen", "ssh", "ssh-keygen", "jq", "node"]
for (const executable of required) {
  if (!commandExists(executable)) throw new Error(`Remote workspace E2E requires ${executable}; this test does not skip missing infrastructure`)
}
const nodeVersion = run("node", ["--version"]).trim()
const nodeMajor = Number(/^v(\d+)\./.exec(nodeVersion)?.[1] ?? 0)
if (nodeMajor < 22) throw new Error(`Remote workspace E2E requires Node.js 22 or newer; found ${nodeVersion}`)
run("docker", ["info"], { timeout: 15_000 })

const root = await mkdtemp(path.join(os.tmpdir(), "kanna-remote-workspace-e2e-"))
const outputDir = path.join(root, "deployment")
const clientKeys = { alice: path.join(root, "alice-client-ed25519"), bob: path.join(root, "bob-client-ed25519") }
const alicePort = await unusedPort()
const bobPort = await unusedPort()
const httpPort = await unusedPort()
const httpsPort = await unusedPort()
const projectName = "project with spaces 中文"
const aliceLocal = path.join(root, "alice-local", projectName)
const bobLocal = path.join(root, "bob-local", "bob-project")
const project = `kanna-e2e-${Date.now().toString(36)}`
const sessions = ["e2e-alice", "e2e-bob"]
const noBuild = process.env.REMOTE_WORKSPACE_E2E_NO_BUILD === "1"
const uid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
const gid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
const mutagenSshPath = path.join(root, "mutagen-ssh")
const mutagenConfig = path.join(root, "mutagen-ssh-config")
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NO_PROXY: [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1", "alice.localhost", "bob.localhost"].filter(Boolean).join(","),
  no_proxy: [process.env.no_proxy, "localhost", "127.0.0.1", "::1", "alice.localhost", "bob.localhost"].filter(Boolean).join(","),
  MUTAGEN_DATA_DIRECTORY: path.join(root, "mutagen-data"),
  MUTAGEN_SSH_PATH: mutagenSshPath,
}
const diagnosticLogPath = process.env.REMOTE_WORKSPACE_E2E_DIAGNOSTIC_LOG
  ?? path.join(os.tmpdir(), `${project}-diagnostics.log`)
let composeStarted = false
let e2eFailed = false
const diagnosticFacts: string[] = []

function compose(args: string[], options: { input?: string } = {}) {
  return run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), ...args], { cwd: outputDir, env, timeout: 600_000, ...options })
}

interface ContainerProcess {
  pid: number
  state: string
  parentPid: number
  processGroup: number
  sessionId: number
  startTime: string
  commandLine: string[]
}

function inspectContainerProcess(account: "alice" | "bob", pid: number): ContainerProcess | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid ${account} container process PID`)
  const script = [
    "const fs = require('node:fs')",
    "const pid = process.argv[1]",
    "try {",
    "  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')",
    "  const close = stat.lastIndexOf(')')",
    "  const fields = stat.slice(close + 2).trim().split(/\\s+/)",
    "  const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`).toString().split('\\0').filter(Boolean)",
    "  process.stdout.write(JSON.stringify({ pid: Number(pid), state: fields[0], parentPid: Number(fields[1]), processGroup: Number(fields[2]), sessionId: Number(fields[3]), startTime: fields[19], commandLine }))",
    "} catch (error) { if (error.code === 'ENOENT') process.stdout.write('null'); else throw error }",
  ].join("; ")
  const output = compose(["exec", "-T", `kanna_${account}`, "node", "-e", script, String(pid)]).trim()
  return JSON.parse(output) as ContainerProcess | null
}

function assertContainerProcessLive(account: "alice" | "bob", pid: number, expectedCommand: string, label: string) {
  const processInfo = inspectContainerProcess(account, pid)
  if (!processInfo || processInfo.state === "Z" || processInfo.state === "X") throw new Error(`${label} process ${pid} is not live in ${account} container`)
  const commandMatches = expectedCommand === "$shell"
    ? processInfo.commandLine.some((part) => /^(?:bash|sh|zsh|fish|ksh)$/.test(path.basename(part)))
    : processInfo.commandLine.some((part) => part.includes(expectedCommand))
  if (!commandMatches) {
    const safeCommand = processInfo.commandLine.map((part) => path.basename(part)).join(" ").slice(0, 120)
    throw new Error(`${label} process ${pid} has unexpected command "${safeCommand}" in ${account} container`)
  }
  return processInfo
}

async function waitForContainerProcessGone(account: "alice" | "bob", processInfo: ContainerProcess, label: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = inspectContainerProcess(account, processInfo.pid)
    if (!current || current.startTime !== processInfo.startTime) return
    await Bun.sleep(100)
  }
  const current = inspectContainerProcess(account, processInfo.pid)
  if (!current) return
  const command = current.commandLine.map((part) => path.basename(part)).join(" ").slice(0, 120)
  throw new Error(`${label} PID ${processInfo.pid} remained after cleanup: state=${current.state} ppid=${current.parentPid} pgid=${current.processGroup} sid=${current.sessionId} starttime=${current.startTime} command=${command}`)
}

function ssh(account: "alice" | "bob", port: number, command: string) {
  const hostKeyFile = path.join(outputDir, "config", `${account}.known_hosts`)
  return run("ssh", [
    "-F", "/dev/null",
    "-i", clientKeys[account],
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=3",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${hostKeyFile}`,
    "-p", String(port),
    `workspace@127.0.0.1`,
    command,
  ], { env, timeout: 10_000 })
}

try {
  await mkdir(path.dirname(aliceLocal), { recursive: true })
  await mkdir(bobLocal, { recursive: true })
  await mkdir(path.join(aliceLocal, ".git"), { recursive: true })
  await writeFile(path.join(aliceLocal, "from-local.txt"), "alice-local\n")
  await writeFile(path.join(aliceLocal, "only-alice.txt"), "private to alice\n")
  await writeFile(path.join(aliceLocal, ".git", "local-only-marker"), "do not sync\n")
  await writeFile(path.join(bobLocal, "from-local.txt"), "bob-local\n")
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKeys.alice])
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", clientKeys.bob])

  await initializeRemoteWorkspace({
    outputDir,
    domain: "localhost",
    local: true,
    accounts: [{ name: "alice", sshPort: alicePort }, { name: "bob", sshPort: bobPort }],
    runtimeUid: uid,
    runtimeGid: gid,
    publicKeys: { alice: `${clientKeys.alice}.pub`, bob: `${clientKeys.bob}.pub` },
  })
  const manifest = JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")) as { domain?: string; local?: boolean; runtimeUid?: number }
  diagnosticFacts.push(`Manifest local=${manifest.local} domain=${manifest.domain} Alice origin=https://alice.${manifest.domain}:${httpsPort}`)
  diagnosticFacts.push(`Selected local published ports: HTTP=${httpPort}, HTTPS=${httpsPort}; SSH Alice=${alicePort}, Bob=${bobPort}`)
  await generateRemoteWorkspaceFiles(outputDir)
  // Local mode defaults to 8080/8443, which may be occupied by another developer stack.
  const composePath = path.join(outputDir, "compose.yaml")
  const composeContents = await readFile(composePath, "utf8")
  await writeFile(composePath, composeContents
    .replace('127.0.0.1:8080:80', `127.0.0.1:${httpPort}:80`)
    .replace('127.0.0.1:8443:443', `127.0.0.1:${httpsPort}:443`))
  const dynamicCompose = await readFile(composePath, "utf8")
  if (!dynamicCompose.includes(`127.0.0.1:${httpPort}:80`) || !dynamicCompose.includes(`127.0.0.1:${httpsPort}:443`)) {
    throw new Error("Local Caddy port replacement did not preserve loopback-only bindings")
  }
  await mkdir(mutagenSshPath, { mode: 0o700 })
  const aliases = [sshAlias("127.0.0.1", alicePort), sshAlias("127.0.0.1", bobPort)]
  await writeFile(mutagenConfig, [
    `Host ${aliases[0]}`,
    "  HostName 127.0.0.1",
    `  Port ${alicePort}`,
    "  User workspace",
    `  IdentityFile ${clientKeys.alice}`,
    `  UserKnownHostsFile ${path.join(outputDir, "config", "alice.known_hosts")}`,
    "  StrictHostKeyChecking yes",
    "  IdentitiesOnly yes",
    `Host ${aliases[1]}`,
    "  HostName 127.0.0.1",
    `  Port ${bobPort}`,
    "  User workspace",
    `  IdentityFile ${clientKeys.bob}`,
    `  UserKnownHostsFile ${path.join(outputDir, "config", "bob.known_hosts")}`,
    "  StrictHostKeyChecking yes",
    "  IdentitiesOnly yes",
    "",
  ].join("\n"))
  for (const tool of ["ssh", "scp"]) {
    const binary = spawnSync("which", [tool], { encoding: "utf8" }).stdout.trim()
    if (!binary) throw new Error(`Unable to find ${tool} for isolated Mutagen SSH setup`)
    const wrapper = path.join(mutagenSshPath, tool)
    await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(binary)} -F ${shellQuote(mutagenConfig)} "$@"\n`, { mode: 0o700 })
    await chmod(wrapper, 0o700)
  }
  env.PATH = `${mutagenSshPath}:${process.env.PATH ?? ""}`
  const syncScript = path.join(outputDir, "sync.sh")
  const validMutagenConfig = await readFile(mutagenConfig, "utf8")
  const invalidSshConfigs = [
    ...["ask", "no", "off"].map((value) => ({ label: `StrictHostKeyChecking ${value}`, config: validMutagenConfig.replace("StrictHostKeyChecking yes", `StrictHostKeyChecking ${value}`) })),
    { label: "IdentitiesOnly no", config: validMutagenConfig.replace("IdentitiesOnly yes", "IdentitiesOnly no") },
    { label: "wrong SSH user", config: validMutagenConfig.replace("  User workspace", "  User nobody") },
    ...["none", "/dev/null", "~/.ssh/known_hosts", "/tmp/kanna-nonexistent-known-hosts"].map((value) => ({ label: `UserKnownHostsFile ${value}`, config: validMutagenConfig.replace(/UserKnownHostsFile [^\n]+/, `UserKnownHostsFile ${value}`) })),
  ]
  for (const invalid of invalidSshConfigs) {
    await writeFile(mutagenConfig, invalid.config)
    const rejected = spawnSync("bash", [syncScript, "create", "alice", aliceLocal, projectName, "strict-hostkey-negative-test"], {
      cwd: outputDir,
      env,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: outputLimit,
    })
    const output = `${rejected.stdout ?? ""}\n${rejected.stderr ?? ""}`
    if (rejected.error || rejected.status === 0 || !(output.includes("must map to") || output.includes("must use a readable dedicated UserKnownHostsFile"))) {
      throw new Error(`sync.sh did not reject ${invalid.label} before network access`)
    }
    diagnosticFacts.push(`sync.sh rejected ${invalid.label}`)
  }
  await writeFile(mutagenConfig, validMutagenConfig)
  run("bun", ["run", path.join(path.dirname(new URL(import.meta.url).pathname), "remote-workspace.ts"), "doctor", "--output", outputDir], { env })
  const agent = run("ssh-agent", ["-s"])
  const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(agent)?.[1]
  const pid = /SSH_AGENT_PID=([0-9]+);/.exec(agent)?.[1]
  if (!socket || !pid) throw new Error("Unable to start isolated SSH agent")
  Object.assign(env, { SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid })
  run("ssh-add", [clientKeys.alice, clientKeys.bob], { env })
  composeStarted = true
  compose(["up", "-d", ...(noBuild ? ["--no-build"] : ["--build"])])
  for (const account of ["alice", "bob"] as const) {
    const containerId = compose(["ps", "-q", `kanna_${account}`]).trim()
    if (!containerId) throw new Error(`Missing ${account} app container after compose up`)
    assertEqual(run("docker", ["inspect", "--format", "{{.HostConfig.Init}}", containerId]).trim(), "true", `${account} app init reaper enabled`)
    const runtime = JSON.parse(compose(["exec", "-T", `kanna_${account}`, "node", "-e", [
      "const fs = require('node:fs')",
      "const init = fs.readFileSync('/proc/1/comm', 'utf8').trim()",
      "let app",
      "for (const entry of fs.readdirSync('/proc')) { if (!/^\\d+$/.test(entry) || entry === '1') continue; try { const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8'); const close = stat.lastIndexOf(')'); const fields = stat.slice(close + 2).trim().split(/\\s+/); if (fields[1] !== '1') continue; const commandLine = fs.readFileSync(`/proc/${entry}/cmdline`).toString().split('\\0').filter(Boolean); if (!commandLine.some((arg) => arg.endsWith('/bin/kanna') || arg === './bin/kanna')) continue; const status = fs.readFileSync(`/proc/${entry}/status`, 'utf8'); app = { pid: Number(entry), comm: fs.readFileSync(`/proc/${entry}/comm`, 'utf8').trim(), uid: /^Uid:\\s+(\\d+)/m.exec(status)?.[1] }; break } catch {} }",
      "process.stdout.write(JSON.stringify({ init, app }))",
    ].join("; ")]).trim()) as { init?: string; app?: { pid?: number; comm?: string; uid?: string } }
    if (!/(?:docker-init|tini)/i.test(runtime.init ?? "")) throw new Error(`${account} app PID 1 is not the Docker init reaper`)
    if (!runtime.app || !/bun/i.test(runtime.app.comm ?? "")) throw new Error(`${account} Kanna Bun process is not an init child`)
    assertEqual(runtime.app.uid ?? "", String(uid), `${account} Bun process remains nonroot`)
  }
  diagnosticFacts.push(`Docker init reaper is PID 1; Kanna Bun child is UID ${uid} in both app containers`)
  const actualHttpBinding = compose(["port", "caddy", "80"]).trim()
  const actualHttpsBinding = compose(["port", "caddy", "443"]).trim()
  diagnosticFacts.push(`Compose published bindings: HTTP=${actualHttpBinding}, HTTPS=${actualHttpsBinding}`)
  assertEqual(actualHttpBinding, `127.0.0.1:${httpPort}`, "Caddy HTTP loopback port publication")
  assertEqual(actualHttpsBinding, `127.0.0.1:${httpsPort}`, "Caddy HTTPS loopback port publication")

  const deadline = Date.now() + 90_000
  let aliceReady = false
  let bobReady = false
  while (Date.now() < deadline && (!aliceReady || !bobReady)) {
    if (!aliceReady) {
      try { ssh("alice", alicePort, "id -u") ; aliceReady = true } catch {}
    }
    if (!bobReady) {
      try { ssh("bob", bobPort, "id -u") ; bobReady = true } catch {}
    }
    if (!aliceReady || !bobReady) await Bun.sleep(1000)
  }
  if (!aliceReady || !bobReady) throw new Error("SSH sidecars did not become ready before the deadline")
  assertEqual(ssh("alice", alicePort, "id -u"), String(uid), "alice SSH runtime UID")
  assertEqual(ssh("bob", bobPort, "id -u"), String(uid), "bob SSH runtime UID")
  assertEqual(compose(["exec", "-T", "kanna_alice", "id", "-u"]), String(uid), "alice Kanna container UID")
  assertEqual(compose(["exec", "-T", "kanna_bob", "id", "-u"]), String(uid), "bob Kanna container UID")
  assertEqual(compose(["exec", "-T", "kanna_alice", "codex", "--version"]), "codex-cli 0.161.0", "pinned Codex CLI version")
  const aliceOrigin = `https://alice.localhost:${httpsPort}`
  let localCa = ""
  const caDeadline = Date.now() + 30_000
  while (Date.now() < caDeadline && !localCa) {
    try {
      const candidate = compose(["exec", "-T", "caddy", "cat", "/data/caddy/pki/authorities/local/root.crt"])
      if (candidate.startsWith("-----BEGIN CERTIFICATE-----")) localCa = candidate
    } catch {}
    if (!localCa) await Bun.sleep(500)
  }
  if (!localCa) throw new Error("Caddy local root CA did not become available")
  diagnosticFacts.push(`HTTPS transport: real Node ${run("node", ["--version"]).trim()} helper; hostname=127.0.0.1 port=${httpsPort} servername=alice.localhost Host=alice.localhost:${httpsPort} path=/health rejectUnauthorized=true CA=Caddy-local-root`)
  const alicePassword = (await readFile(path.join(outputDir, "secrets", "alice", "app-password"), "utf8")).trim()
  let healthReady = false
  let healthFailure = "no HTTP response was received"
  const healthDeadline = Date.now() + 30_000
  while (Date.now() < healthDeadline && !healthReady) {
    try {
      const health = await hostedHttpsRequest({ host: "alice.localhost", port: httpsPort, ca: localCa, path: "/health", method: "GET" })
      healthFailure = `HTTP ${health.status}: ${health.body.slice(0, 200)}`
      diagnosticFacts.push(`HTTPS /health readiness: ${healthFailure}`)
      if (health.status === 200) healthReady = true
      else if (health.status !== 502 && health.status !== 503) throw new Error(`Alice hosted HTTPS /health rejected ${healthFailure}`)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Alice hosted HTTPS /health rejected")) throw error
      healthFailure = error instanceof Error ? error.message : "unknown transport error"
      diagnosticFacts.push(`HTTPS /health readiness transport: ${healthFailure}`)
    }
    if (!healthReady) await Bun.sleep(500)
  }
  if (!healthReady) {
    const caPath = path.join(root, "caddy-local-root-ca.pem")
    await writeFile(caPath, localCa, { mode: 0o600 })
    await chmod(caPath, 0o600)
    const comparison = diagnoseStrictHttpsHealth({ host: "alice.localhost", port: httpsPort, caPath })
    diagnosticFacts.push(`HTTPS /health failure comparison: ${comparison}`)
    throw new Error(`Alice hosted HTTPS /health did not become ready (${healthFailure}); ${comparison}`)
  }
  const login = await loginOnHostedApp("alice.localhost", aliceOrigin, alicePassword, localCa, httpsPort)
  if (login.status !== 200) throw new Error(`Alice /auth/login rejected HTTP ${login.status}: ${login.body.slice(0, 200)}`)
  const setCookie = login.headers["set-cookie"]?.[0]
  const aliceCookie = setCookie?.split(";", 1)[0]
  if (!aliceCookie?.startsWith("kanna_session=")) throw new Error("Alice login did not issue the expected session cookie")
  if (!setCookie?.split(";").some((attribute) => attribute.trim().toLowerCase() === "secure")) throw new Error("Alice HTTPS session cookie did not have the Secure attribute")
  const diagnosticsBody = JSON.stringify({ clientId: "remote-workspace-e2e-origin", metrics: {} })
  const bobPassword = (await readFile(path.join(outputDir, "secrets", "bob", "app-password"), "utf8")).trim()
  const bobOnAliceLogin = await loginOnHostedApp("alice.localhost", aliceOrigin, bobPassword, localCa, httpsPort)
  assertEqual(String(bobOnAliceLogin.status), "401", "Bob password rejected by Alice account")
  const bobLogin = await loginOnHostedApp("bob.localhost", `https://bob.localhost:${httpsPort}`, bobPassword, localCa, httpsPort)
  assertEqual(String(bobLogin.status), "200", "Bob account password login")
  const bobCookie = bobLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0]
  if (!bobCookie?.startsWith("kanna_session=")) throw new Error("Bob login did not issue a session cookie")
  const aliceCookieOnBob = await hostedHttpsRequest({
    host: "bob.localhost", port: httpsPort, ca: localCa, path: "/api/diagnostics/client", method: "POST",
    headers: { Origin: `https://bob.localhost:${httpsPort}`, Cookie: aliceCookie, "Content-Type": "application/json" }, body: diagnosticsBody,
  })
  assertEqual(String(aliceCookieOnBob.status), "401", "Alice session cookie rejected by Bob account")
  const bobCookieOnAlice = await hostedHttpsRequest({
    host: "alice.localhost", port: httpsPort, ca: localCa, path: "/api/diagnostics/client", method: "POST",
    headers: { Origin: aliceOrigin, Cookie: bobCookie, "Content-Type": "application/json" }, body: diagnosticsBody,
  })
  assertEqual(String(bobCookieOnAlice.status), "401", "Bob session cookie rejected by Alice account")
  const sameOriginPost = await hostedHttpsRequest({
    host: "alice.localhost",
    port: httpsPort,
    path: "/api/diagnostics/client",
    method: "POST",
    ca: localCa,
    headers: { Origin: aliceOrigin, Cookie: aliceCookie, "Content-Type": "application/json" },
    body: diagnosticsBody,
  })
  assertEqual(String(sameOriginPost.status), "204", "same-origin authenticated POST")
  const siblingOriginPost = await hostedHttpsRequest({
    host: "alice.localhost",
    port: httpsPort,
    path: "/api/diagnostics/client",
    method: "POST",
    ca: localCa,
    headers: { Origin: `https://bob.localhost:${httpsPort}`, Cookie: aliceCookie, "Content-Type": "application/json" },
    body: diagnosticsBody,
  })
  assertEqual(String(siblingOriginPost.status), "403", "sibling-origin authenticated POST rejection")
  const unauthMetadata = await hostedHttpsRequest({ host: "alice.localhost", port: httpsPort, ca: localCa, path: "/api/hosted-workspace", method: "GET" })
  assertEqual(String(unauthMetadata.status), "401", "unauthenticated hosted-workspace metadata rejection")
  const unauthApi = await hostedHttpsRequest({
    host: "alice.localhost", port: httpsPort, ca: localCa, path: "/api/diagnostics/client", method: "POST",
    headers: { Origin: aliceOrigin, "Content-Type": "application/json" }, body: diagnosticsBody,
  })
  assertEqual(String(unauthApi.status), "401", "unauthenticated API rejection")
  assertEqual(String(await websocketUpgrade("alice.localhost", aliceOrigin, "", localCa, httpsPort)), "401", "unauthenticated WebSocket rejection")
  assertEqual(String(await websocketUpgrade("alice.localhost", aliceOrigin, aliceCookie, localCa, httpsPort)), "101", "same-origin authenticated WebSocket upgrade")
  assertEqual(String(await websocketUpgrade("alice.localhost", `https://bob.localhost:${httpsPort}`, aliceCookie, localCa, httpsPort)), "403", "sibling-origin authenticated WebSocket rejection")

  let projectPath = "/workspace/kanna-e2e-project"
  const workspaceSocket = await openAuthenticatedWebSocket("alice.localhost", aliceOrigin, aliceCookie, localCa, httpsPort)
  wsCommand(workspaceSocket.socket, "e2e-project-create", { type: "project.create", localPath: projectPath, title: "remote workspace E2E" })
  const projectCreated = await workspaceSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-project-create", "project.create ack")
  let projectId = (projectCreated.result as { projectId?: string } | undefined)?.projectId
  if (!projectId) throw new Error("project.create acknowledgement did not include projectId")
  const bobRemotePtyPath = "/workspace/bob-project"
  ssh("bob", bobPort, `mkdir -p ${shellQuote(bobRemotePtyPath)}`)
  const bobSocket = await openAuthenticatedWebSocket("bob.localhost", `https://bob.localhost:${httpsPort}`, bobCookie, localCa, httpsPort)
  let bobTerminalId = ""
  try {
    wsCommand(bobSocket.socket, "e2e-bob-project-create", { type: "project.create", localPath: bobRemotePtyPath, title: "remote workspace Bob isolation E2E" })
    const bobProjectCreated = await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-project-create", "Bob project.create ack")
    const bobProjectId = (bobProjectCreated.result as { projectId?: string } | undefined)?.projectId
    if (!bobProjectId) throw new Error("Bob project.create acknowledgement did not include projectId")
    bobTerminalId = "remote-workspace-e2e-bob-isolation"
    wsCommand(bobSocket.socket, "e2e-bob-terminal-create", { type: "terminal.create", projectId: bobProjectId, terminalId: bobTerminalId, cols: 80, rows: 24, scrollback: 1_000 })
    const bobTerminalCreated = await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-create", "Bob terminal.create ack")
    assertEqual((bobTerminalCreated.result as { status?: string } | undefined)?.status ?? "", "running", "Bob isolation terminal initial status")
    bobSocket.socket.send(JSON.stringify({ v: 1, type: "subscribe", id: "e2e-bob-terminal-subscription", topic: { type: "terminal", terminalId: bobTerminalId } }))
    await bobSocket.waitFor((message) => message.type === "snapshot" && message.id === "e2e-bob-terminal-subscription", "Bob terminal initial snapshot")
    wsCommand(bobSocket.socket, "e2e-bob-terminal-shell-pid", {
      type: "terminal.input",
      terminalId: bobTerminalId,
      data: `printf '\\n%s%s shell=%s\\n' '__E2E_BOB_' 'SHELL' "$$"\r`,
    })
    await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-shell-pid", "Bob terminal shell PID input ack")
    let bobShellOutput = ""
    let bobShellPid: number | undefined
    const bobShellDeadline = Date.now() + 5_000
    while (bobShellPid === undefined && Date.now() < bobShellDeadline) {
      const message = await bobSocket.waitFor((value) => {
        if (value.type !== "event" || value.id !== "e2e-bob-terminal-subscription") return false
        const event = value.event as { type?: string; terminalId?: string } | undefined
        return event?.type === "terminal.output" && event.terminalId === bobTerminalId
      }, "Bob terminal shell PID output", bobShellDeadline - Date.now())
      bobShellOutput += (message.event as { data?: string }).data ?? ""
      const line = bobShellOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/[\r\n]+/).map((value) => value.trim()).find((value) => value.startsWith("__E2E_BOB_SHELL shell="))
      const match = line?.match(/^__E2E_BOB_SHELL shell=(\d+)$/)
      if (match) bobShellPid = Number(match[1])
    }
    if (bobShellPid === undefined) throw new Error("Bob terminal did not report its shell PID")
    const bobShellProcess = assertContainerProcessLive("bob", bobShellPid, "$shell", "Bob terminal shell")
  await runPtyCheck(
    workspaceSocket.socket,
    workspaceSocket.waitFor,
    projectId,
    projectPath,
    "before-restart",
    `pwd\r${printfLine("kanna-e2e-pty-marker")} > .kanna-e2e-marker\r${printfLine("K_E2E_PTY_BEFORE_DONE", true)}\r`,
    "K_E2E_PTY_BEFORE_DONE"
  )
  wsCommand(bobSocket.socket, "e2e-bob-terminal-delayed-marker", {
    type: "terminal.input",
    terminalId: bobTerminalId,
    data: `sleep 2; ${printfLine("K_E2E_BOB_UNAFFECTED", true)}\r`,
  })
  await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-delayed-marker", "Bob terminal delayed marker input ack")
  const ctrlCSmoke = await runPtyInterruptSmoke(workspaceSocket.socket, workspaceSocket.waitFor, projectId, projectPath, bobShellProcess)
  if (!ctrlCSmoke.supported) throw new Error(`Kanna PTY Ctrl-C smoke failed: ${ctrlCSmoke.reason}`)
  diagnosticFacts.push(`Kanna PTY Ctrl-C smoke passed: ${ctrlCSmoke.reason}`)
  let bobOutput = ""
  const bobDeadline = Date.now() + 5_000
  while (Date.now() < bobDeadline) {
    const message = await bobSocket.waitFor((value) => {
      if (value.type !== "event" || value.id !== "e2e-bob-terminal-subscription") return false
      const event = value.event as { type?: string; terminalId?: string } | undefined
      return event?.type === "terminal.output" && event.terminalId === bobTerminalId
    }, "Bob isolated terminal output", bobDeadline - Date.now())
    const event = message.event as { data?: string }
    bobOutput += event.data ?? ""
    const cleaned = bobOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    if (cleaned.split(/[\r\n]+/).some((line) => line.trim() === "K_E2E_BOB_UNAFFECTED")) break
  }
  if (!bobOutput.includes("K_E2E_BOB_UNAFFECTED")) throw new Error("Bob terminal process was affected by Alice PTY Ctrl-C activity")
  assertEqual(inspectContainerProcess("bob", bobShellProcess.pid)?.startTime ?? "", bobShellProcess.startTime, "Bob terminal shell survives Alice Ctrl-C")
  wsCommand(bobSocket.socket, "e2e-bob-terminal-status", { type: "terminal.tail", terminalId: bobTerminalId, sinceVersion: null })
  const bobTail = await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-status", "Bob terminal status tail")
  assertEqual((bobTail.result as { snapshot?: { status?: string } } | undefined)?.snapshot?.status ?? "", "running", "Bob terminal remains alive")
  diagnosticFacts.push("Bob terminal delayed marker and running status survived Alice Ctrl-C tests")
  wsCommand(bobSocket.socket, "e2e-bob-terminal-close", { type: "terminal.close", terminalId: bobTerminalId })
  await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-close", "Bob terminal close ack")
  workspaceSocket.socket.close()
  } finally {
    if (bobTerminalId && bobSocket.socket) {
      wsCommand(bobSocket.socket, "e2e-bob-terminal-cleanup", { type: "terminal.close", terminalId: bobTerminalId })
      await bobSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-bob-terminal-cleanup", "Bob terminal cleanup ack").catch(() => {})
    }
    bobSocket.socket.close()
  }

  const appServer = await codexAppServerInitialize({
    cwd: outputDir,
    env,
    composeArgs: ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "exec", "-T", "-w", "/workspace", "kanna_alice", "codex", "app-server"],
  })
  diagnosticFacts.push(`Codex app-server initialize: ${appServer.summary}; stdoutJsonLines=${appServer.parsedLineCount}; stderr=${appServer.stderr || "empty"}`)

  const aliceRemote = `/workspace/${projectName}`
  const bobRemote = "/workspace/bob-project"
  ssh("alice", alicePort, `mkdir -p ${shellQuote(aliceRemote)}`)
  ssh("bob", bobPort, `mkdir -p ${shellQuote(bobRemote)}`)
  run("bash", [syncScript, "create", "alice", aliceLocal, projectName, sessions[0]!], { env })
  run("bash", [syncScript, "create", "bob", bobLocal, "bob-project", sessions[1]!], { env })
  await flushMutagen(sessions[0]!, env, "Alice initial sync")
  await flushMutagen(sessions[1]!, env, "Bob initial sync")
  assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/from-local.txt`)}`), "base64").toString(), "alice-local\n", "alice local-to-remote sync")
  assertExact(Buffer.from(ssh("bob", bobPort, `base64 -w 0 ${shellQuote(`${bobRemote}/from-local.txt`)}`), "base64").toString(), "bob-local\n", "bob local-to-remote sync")
  assertEqual(ssh("alice", alicePort, `git -C ${shellQuote(aliceRemote)} rev-parse --is-inside-work-tree`), "true", "remote git repository initialization")
  assertEqual(ssh("alice", alicePort, `test ! -e ${shellQuote(`${aliceRemote}/.git/local-only-marker`)}`), "", "local Git metadata stays local")
  ssh("alice", alicePort, `printf 'alice-remote\\n' > ${shellQuote(`${aliceRemote}/from-remote.txt`)}`)
  await flushMutagen(sessions[0]!, env, "Alice remote-to-local sync")
  assertExact(await readFile(path.join(aliceLocal, "from-remote.txt"), "utf8"), "alice-remote\n", "alice remote-to-local sync")
  const bobCannotSeeAlice = ssh("bob", bobPort, `test ! -e ${shellQuote(`${aliceRemote}/only-alice.txt`)}`)
  assertEqual(bobCannotSeeAlice, "", "account workspace isolation")

  await writeFile(path.join(aliceLocal, "new-local-file.txt"), "created locally\n")
  await flushMutagen(sessions[0]!, env, "new local file sync")
  assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/new-local-file.txt`)}`), "base64").toString(), "created locally\n", "new local file sync")
  ssh("alice", alicePort, `printf 'created remotely\\n' > ${shellQuote(`${aliceRemote}/new-remote-file.txt`)}`)
  await flushMutagen(sessions[0]!, env, "new remote file sync")
  assertExact(await readFile(path.join(aliceLocal, "new-remote-file.txt"), "utf8"), "created remotely\n", "new remote file sync")

  const localBinary = Buffer.from([0, 1, 2, 127, 128, 254, 255])
  await writeFile(path.join(aliceLocal, "local-binary.bin"), localBinary)
  await flushMutagen(sessions[0]!, env, "local binary sync")
  assertEqual(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/local-binary.bin`)}`), localBinary.toString("base64"), "local binary file sync")
  const remoteBinary = Buffer.from([255, 0, 17, 34, 128, 65])
  ssh("alice", alicePort, `printf %s ${shellQuote(remoteBinary.toString("base64"))} | base64 -d > ${shellQuote(`${aliceRemote}/remote-binary.bin`)}`)
  await flushMutagen(sessions[0]!, env, "remote binary sync")
  if (!(await readFile(path.join(aliceLocal, "remote-binary.bin"))).equals(remoteBinary)) throw new Error("remote binary file sync: content differed")

  await rm(path.join(aliceLocal, "only-alice.txt"))
  await flushMutagen(sessions[0]!, env, "local deletion sync")
  assertEqual(ssh("alice", alicePort, `test ! -e ${shellQuote(`${aliceRemote}/only-alice.txt`)}`), "", "local deletion sync")
  ssh("alice", alicePort, `rm ${shellQuote(`${aliceRemote}/new-remote-file.txt`)}`)
  await flushMutagen(sessions[0]!, env, "remote deletion sync")
  if (await Bun.file(path.join(aliceLocal, "new-remote-file.txt")).exists()) throw new Error("remote deletion sync: local file still exists")

  await writeFile(path.join(aliceLocal, "conflict.txt"), "shared conflict baseline\n")
  await flushMutagen(sessions[0]!, env, "conflict baseline sync")
  assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/conflict.txt`)}`), "base64").toString(), "shared conflict baseline\n", "conflict baseline sync")
  run("bash", [path.join(outputDir, "sync.sh"), "pause", sessions[0]!], { env })
  await writeFile(path.join(aliceLocal, "resumed-after-pause.txt"), "pause-resume\n")
  assertEqual(ssh("alice", alicePort, `test ! -e ${shellQuote(`${aliceRemote}/resumed-after-pause.txt`)}`), "", "paused session stops propagation")
  run("bash", [path.join(outputDir, "sync.sh"), "resume", sessions[0]!], { env })
  await flushMutagen(sessions[0]!, env, "resume after pause")
  assertEqual(ssh("alice", alicePort, `cat ${shellQuote(`${aliceRemote}/resumed-after-pause.txt`)}`), "pause-resume", "resumed session reconnects")

  run("bash", [path.join(outputDir, "sync.sh"), "pause", sessions[0]!], { env })
  const pausedStatus = run("mutagen", ["sync", "list", "--long", sessions[0]!], { env })
  if (!/Status:\s*\[Paused\]/i.test(pausedStatus)) throw new Error(`Mutagen session did not enter paused state before conflict edits: ${pausedStatus.slice(0, 1_000)}`)
  await writeFile(path.join(aliceLocal, "conflict.txt"), "local conflict version\n")
  ssh("alice", alicePort, `printf 'remote conflict version\\n' > ${shellQuote(`${aliceRemote}/conflict.txt`)}`)
  run("bash", [path.join(outputDir, "sync.sh"), "resume", sessions[0]!], { env })
  const conflictDeadline = Date.now() + 30_000
  let conflictStatus = ""
  const hasMutagenConflict = (status: string) => /(?:^|\n)Conflicts:\s*\n\s*\((?:alpha|beta)\)\s+/i.test(status)
  while (Date.now() < conflictDeadline) {
    conflictStatus = run("mutagen", ["sync", "list", "--long", sessions[0]!], { env })
    if (!/Synchronization mode:\s*Two Way Safe/i.test(conflictStatus)) throw new Error(`Mutagen session is not configured for Two Way Safe: ${conflictStatus.slice(0, 1_000)}`)
    if (hasMutagenConflict(conflictStatus)) break
    await Bun.sleep(500)
  }
  if (!hasMutagenConflict(conflictStatus)) throw new Error(`Mutagen two-way-safe did not report the simultaneous edit conflict; final session status: ${conflictStatus.slice(0, 2_000)}`)
  const expectedBetaUrl = `workspace@${aliases[0]}:/workspace/${projectName}`
  if (!conflictStatus.includes(`URL: ${aliceLocal}`) || !conflictStatus.includes(`URL: ${expectedBetaUrl}`) || (conflictStatus.match(/Connected: Yes/g) ?? []).length < 2) {
    throw new Error(`Mutagen conflict came from an unexpected or disconnected session: ${conflictStatus.slice(0, 2_000)}`)
  }
  assertExact(await readFile(path.join(aliceLocal, "conflict.txt"), "utf8"), "local conflict version\n", "local conflict data preservation")
  assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/conflict.txt`)}`), "base64").toString(), "remote conflict version\n", "remote conflict data preservation")
  run("bash", [path.join(outputDir, "sync.sh"), "pause", sessions[0]!], { env })
  await writeFile(path.join(aliceLocal, "conflict.txt"), "manually resolved\n")
  ssh("alice", alicePort, `printf 'manually resolved\\n' > ${shellQuote(`${aliceRemote}/conflict.txt`)}`)
  run("bash", [path.join(outputDir, "sync.sh"), "resume", sessions[0]!], { env })
  await flushMutagen(sessions[0]!, env, "manual conflict resolution")
  assertExact(await readFile(path.join(aliceLocal, "conflict.txt"), "utf8"), "manually resolved\n", "conflict resolution keeps matching files")
  assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/conflict.txt`)}`), "base64").toString(), "manually resolved\n", "remote conflict resolution convergence")
  const resolvedStatus = run("mutagen", ["sync", "list", "--long", sessions[0]!], { env })
  if (hasMutagenConflict(resolvedStatus)) throw new Error(`Mutagen conflict did not clear after matching resolution: ${resolvedStatus.slice(0, 1_000)}`)

  ssh("alice", alicePort, `printf 'survives container restart\\n' > ${shellQuote(`${aliceRemote}/restart-persisted.txt`)}`)
  await flushMutagen(sessions[0]!, env, "restart persistence sync")
  run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "restart", "ssh_alice", "kanna_alice"], { cwd: outputDir, env, timeout: 60_000 })
  const restartDeadline = Date.now() + 60_000
  let aliceRestarted = false
  while (Date.now() < restartDeadline && !aliceRestarted) {
    try { assertEqual(ssh("alice", alicePort, "id -u"), String(uid), "restarted Alice SSH runtime UID"); aliceRestarted = true } catch { await Bun.sleep(1000) }
  }
  if (!aliceRestarted) throw new Error("Alice SSH sidecar did not recover after container restart")
  await flushMutagen(sessions[0]!, env, "post-restart persistence sync")
  assertExact(await readFile(path.join(aliceLocal, "restart-persisted.txt"), "utf8"), "survives container restart\n", "workspace survives app and SSH restart")

  const postRestartHealthDeadline = Date.now() + 30_000
  let postRestartHealth = false
  while (Date.now() < postRestartHealthDeadline && !postRestartHealth) {
    try {
      const health = await hostedHttpsRequest({ host: "alice.localhost", port: httpsPort, ca: localCa, path: "/health", method: "GET" })
      postRestartHealth = health.status === 200
    } catch {}
    if (!postRestartHealth) await Bun.sleep(500)
  }
  if (!postRestartHealth) throw new Error("Alice app did not become healthy after container restart")
  const restartedLogin = await loginOnHostedApp("alice.localhost", aliceOrigin, alicePassword, localCa, httpsPort)
  if (restartedLogin.status !== 200) throw new Error(`Alice /auth/login after restart returned HTTP ${restartedLogin.status}: ${restartedLogin.body.slice(0, 200)}`)
  const restartedCookie = restartedLogin.headers["set-cookie"]?.[0]?.split(";", 1)[0]
  if (!restartedCookie?.startsWith("kanna_session=")) throw new Error("Alice restart login did not issue a session cookie")
  const restartedSocket = await openAuthenticatedWebSocket("alice.localhost", aliceOrigin, restartedCookie, localCa, httpsPort)
  wsCommand(restartedSocket.socket, "e2e-project-open-after-restart", { type: "project.open", localPath: projectPath })
  const projectOpened = await restartedSocket.waitFor((message) => message.type === "ack" && message.id === "e2e-project-open-after-restart", "project.open after restart ack")
  projectId = (projectOpened.result as { projectId?: string } | undefined)?.projectId ?? ""
  if (!projectId) throw new Error("project.open acknowledgement did not include projectId after restart")
  await runPtyCheck(
    restartedSocket.socket,
    restartedSocket.waitFor,
    projectId,
    projectPath,
    "after-restart",
    `pwd\rcat .kanna-e2e-marker\r${printfLine("K_E2E_PTY_AFTER_DONE", true)}\r`,
    "K_E2E_PTY_AFTER_DONE",
    "kanna-e2e-pty-marker"
  )
  restartedSocket.socket.close()

  const backupPath = path.join(root, "deployment-backup.tar")
  const aliceHostKey = await readFile(path.join(outputDir, "state", "alice", "ssh-host-ed25519.pub"))
  const alicePasswordBackup = await readFile(path.join(outputDir, "secrets", "alice", "app-password"))
  run("tar", ["--create", "--file", backupPath, "--directory", root, "deployment"])
  await chmod(backupPath, 0o600)
  const restoreOwnerArgs = ["--numeric-owner"]
  if (typeof process.getuid !== "function") throw new Error("Cannot verify runner UID for backup restore")
  const runnerUid = process.getuid()
  if (runnerUid === 0) {
    restoreOwnerArgs.push("--same-owner")
  } else {
    const composeConfig = JSON.parse(compose(["config", "--format", "json"])) as {
      services?: Record<string, { user?: string }>
    }
    const appUid = composeConfig.services?.kanna_alice?.user?.split(":", 1)[0]
    if (!Number.isInteger(manifest.runtimeUid) || manifest.runtimeUid !== runnerUid || appUid !== String(runnerUid)) {
      throw new Error(`Cannot restore ownership as non-root: manifest app UID ${manifest.runtimeUid ?? "unknown"} and Compose app UID ${appUid ?? "unknown"} must match runner UID ${runnerUid}`)
    }
    restoreOwnerArgs.push("--no-same-owner")
  }
  run("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "down", "--remove-orphans"], { cwd: outputDir, env, timeout: 60_000 })
  composeStarted = false
  await rm(outputDir, { recursive: true, force: true })
  await mkdir(outputDir, { mode: 0o700 })
  run("tar", ["--extract", "--file", backupPath, "--directory", root, ...restoreOwnerArgs])
  if (!(await readFile(path.join(outputDir, "state", "alice", "ssh-host-ed25519.pub"))).equals(aliceHostKey)) throw new Error("backup restore changed Alice SSH host key")
  if (!(await readFile(path.join(outputDir, "secrets", "alice", "app-password"))).equals(alicePasswordBackup)) throw new Error("backup restore changed Alice app password")
  if (await stat(path.join(outputDir, "secrets", "alice", "app-password")).then((value) => value.mode & 0o077) !== 0) throw new Error("backup restore widened app-password permissions")
  composeStarted = true
  compose(["up", "-d", ...(noBuild ? ["--no-build"] : ["--build"])])
  const restoreDeadline = Date.now() + 90_000
  let restored = false
  while (Date.now() < restoreDeadline && !restored) {
    try {
      assertExact(Buffer.from(ssh("alice", alicePort, `base64 -w 0 ${shellQuote(`${aliceRemote}/restart-persisted.txt`)}`), "base64").toString(), "survives container restart\n", "restored workspace content")
      restored = true
    } catch { await Bun.sleep(1000) }
  }
  if (!restored) throw new Error("Restored deployment did not accept the original pinned SSH identity")
  console.log("Remote workspace two-account Docker, SSH and Mutagen E2E passed")
} catch (error) {
  e2eFailed = true
  throw error
} finally {
  if (composeStarted && diagnosticLogPath) {
    const containerIds = spawnSync("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "ps", "--all", "--quiet"], {
      cwd: outputDir,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: outputLimit,
    }).stdout.trim().split("\n").filter(Boolean)
    const inspect = containerIds.length > 0
      ? spawnSync("docker", ["inspect", "--format", "{{.Name}} status={{.State.Status}} started={{.State.StartedAt}} restarts={{.RestartCount}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}} user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}} bindings={{json .HostConfig.PortBindings}} ports={{json .NetworkSettings.Ports}} envKeys={{range $key, $value := .Config.Env}}{{$key}},{{end}} mounts={{range .Mounts}}{{.Source}}=>{{.Destination}}:rw={{.RW}};{{end}}", ...containerIds], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: outputLimit,
      }).stdout
      : "No Compose containers remained to inspect.\n"
    const hostPaths = [
      path.join(outputDir, "Caddyfile"),
      ...["alice", "bob"].flatMap((account) => [
        path.join(outputDir, "config", `${account}.json`),
        path.join(outputDir, "secrets", account, "app-password"),
        path.join(outputDir, "secrets", account, "authorized_keys"),
        ...["home", "codex", "workspace", "ssh-home"].map((leaf) => path.join(outputDir, "state", account, leaf)),
        path.join(outputDir, "state", account, "ssh-host-ed25519"),
        path.join(outputDir, "state", account, "ssh-host-ed25519.pub"),
      ]),
    ]
    const hostPermissions: string[] = []
    for (const file of hostPaths) {
      try {
        const info = await stat(file)
        hostPermissions.push(`${file} uid=${info.uid} gid=${info.gid} mode=${(info.mode & 0o777).toString(8)} type=${info.isDirectory() ? "dir" : "file"}`)
      } catch {
        hostPermissions.push(`${file} missing`)
      }
    }
    const logs = spawnSync("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "logs", "--no-color", "--tail=120"], {
      cwd: outputDir,
      env,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: outputLimit,
    })
    let serviceLogs = `${logs.stdout ?? ""}${logs.stderr ?? ""}`
    const sensitiveFiles = [
      ...["alice", "bob"].flatMap((account) => [
        path.join(outputDir, "secrets", account, "app-password"),
        path.join(outputDir, "state", account, "ssh-host-ed25519"),
      ]),
      ...Object.values(clientKeys),
    ]
    for (const file of sensitiveFiles) {
      try {
        const secret = (await readFile(file, "utf8")).trim()
        if (secret) serviceLogs = serviceLogs.replaceAll(secret, "[REDACTED]")
      } catch {}
    }
    serviceLogs = serviceLogs
      .replace(/kanna_session=[^;\s]+/gi, "kanna_session=[REDACTED]")
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED]")
    await writeFile(diagnosticLogPath, `${diagnosticFacts.join("\n")}\n${inspect}\nHost permissions:\n${hostPermissions.join("\n")}\n${serviceLogs}`, { mode: 0o600 })
    await chmod(diagnosticLogPath, 0o600)
    if (e2eFailed) console.error(`Remote workspace E2E diagnostics saved to ${diagnosticLogPath}`)
  }
  for (const session of sessions) spawnSync("mutagen", ["sync", "terminate", session], { stdio: "ignore", env })
  // Stop only the daemon addressed by this test's private MUTAGEN_DATA_DIRECTORY.
  // It is intentionally isolated from any Mutagen daemon the developer already runs.
  if (env.MUTAGEN_DATA_DIRECTORY) spawnSync("mutagen", ["daemon", "stop"], { stdio: "ignore", env })
  if (env.SSH_AGENT_PID) spawnSync("ssh-agent", ["-k"], { stdio: "ignore", env })
  if (composeStarted) spawnSync("docker", ["compose", "-p", project, "-f", path.join(outputDir, "compose.yaml"), "down", "--volumes", "--remove-orphans"], { stdio: "ignore", cwd: outputDir, env, timeout: 60_000 })
  await rm(root, { recursive: true, force: true })
}
