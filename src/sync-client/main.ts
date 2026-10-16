import path from "node:path"
import { spawnSync } from "node:child_process"
import { readConnectionFile, RemoteWorkspaceSyncHelper, startLocalSyncServer, getEmbeddedServerOrigin } from "./helper"

function dispatchOpenSsh() {
  const invocationNames = [process.argv[0], process.execPath].filter(Boolean).map((value) => path.basename(value!).toLowerCase())
  const kind = invocationNames.find((name) => name === "ssh" || name === "ssh.exe" || name === "scp" || name === "scp.exe")
  if (process.env.KANNA_SYNC_DISPATCHER_DIAGNOSTICS === "1") process.stderr.write(`${JSON.stringify({ argv: process.argv.slice(0, 4), execPath: process.execPath, invocationNames, kind })}\n`)
  if (!kind && process.env.KANNA_SYNC_DISPATCHER_DIAGNOSTICS === "1") process.exit(125)
  if (!kind) return false
  const isScp = kind.startsWith("scp")
  const executable = process.env[isScp ? "KANNA_SYNC_REAL_SCP_PATH" : "KANNA_SYNC_REAL_SSH_PATH"]
  const config = process.env.KANNA_SYNC_SSH_CONFIG
  if (!executable || !config) {
    process.stderr.write("Kanna Sync SSH dispatcher configuration is unavailable\n")
    process.exit(126)
  }
  const forwardedArguments = process.argv.slice(1)
  if (forwardedArguments[0]?.includes("$bunfs")) forwardedArguments.shift()
  const result = spawnSync(executable, ["-F", config, ...forwardedArguments], {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  })
  if (result.error) {
    process.stderr.write("Kanna Sync could not start the bundled SSH client\n")
    process.exit(127)
  }
  process.exit(result.status ?? 1)
}

async function main() {
  dispatchOpenSsh()
  const connectionFile = path.join(path.dirname(process.execPath), "connection.json")
  const origin = await readConnectionFile(connectionFile, getEmbeddedServerOrigin())
  const helper = new RemoteWorkspaceSyncHelper(origin)
  await helper.initialize()
  const { server } = startLocalSyncServer(helper)
  const close = () => {
    server.stop(true)
    process.exit(0)
  }
  process.once("SIGINT", close)
  process.once("SIGTERM", close)
}

main().catch(() => {
  process.exitCode = 1
})
