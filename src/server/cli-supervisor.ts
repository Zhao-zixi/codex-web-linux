import process from "node:process"
import path from "node:path"
import { homedir } from "node:os"
import { spawn } from "node:child_process"
import { CLI_COMMAND, getDataRootDir, LOG_PREFIX } from "../shared/branding"
import {
  CLI_CHILD_ARGS_ENV_VAR,
  CLI_CHILD_COMMAND_ENV_VAR,
  CLI_CHILD_MODE,
  CLI_CHILD_MODE_ENV_VAR,
  CLI_STARTUP_UPDATE_RESTART_EXIT_CODE,
  CLI_SUPPRESS_OPEN_ONCE_ENV_VAR,
  isUiUpdateRestart,
  parseChildArgsEnv,
  sanitizeRestartArgv,
  shouldRestartCliProcess,
  splitBunRuntimeFlags,
  withBunRuntimeFlags,
} from "./restart"
import { exitWithParent } from "./mac-app"

interface ChildExit {
  code: number | null
  signal: NodeJS.Signals | null
}

function getChildProcessSpec() {
  const overridden = Boolean(process.env[CLI_CHILD_COMMAND_ENV_VAR])
  const command = process.env[CLI_CHILD_COMMAND_ENV_VAR] || CLI_COMMAND
  const args = parseChildArgsEnv(process.env[CLI_CHILD_ARGS_ENV_VAR])
  return withBunRuntimeFlags({ command, args }, bunArgs, {
    execPath: process.execPath,
    script: process.argv[1],
    overridden,
  })
}

function spawnChild(argv: string[]) {
  const childProcess = getChildProcessSpec()
  const suppressOpenThisChild = suppressOpenOnNextChild
  const skipUpdateThisChild = skipUpdateOnNextChild
  suppressOpenOnNextChild = false
  skipUpdateOnNextChild = false
  return new Promise<ChildExit>((resolve, reject) => {
    const child = spawn(childProcess.command, [...childProcess.args, ...argv], {
      stdio: "inherit",
      env: {
        ...process.env,
        [CLI_CHILD_MODE_ENV_VAR]: CLI_CHILD_MODE,
        ...(suppressOpenThisChild ? { [CLI_SUPPRESS_OPEN_ONCE_ENV_VAR]: "1" } : {}),
        ...(skipUpdateThisChild ? { KANNA_DISABLE_SELF_UPDATE: "1" } : {}),
      },
    })

    currentChild = child

    const forwardSignal = (signal: NodeJS.Signals) => {
      if (child.exitCode !== null) return
      child.kill(signal)
    }

    const onSigint = () => {
      forwardSignal("SIGINT")
    }
    const onSigterm = () => {
      forwardSignal("SIGTERM")
    }

    process.on("SIGINT", onSigint)
    process.on("SIGTERM", onSigterm)

    child.once("error", (error) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      reject(error)
    })

    child.once("exit", (code, signal) => {
      process.off("SIGINT", onSigint)
      process.off("SIGTERM", onSigterm)
      resolve({ code, signal })
    })
  })
}

let currentChild: ReturnType<typeof spawn> | null = null
let orphaned = false
// Started by the Mac app, which then crashed: stop the server cleanly and
// don't restart it.
exitWithParent(() => {
  if (orphaned) return
  orphaned = true
  if (currentChild && currentChild.exitCode === null) currentChild.kill("SIGTERM")
})

const profileDir = path.join(getDataRootDir(homedir()), "profiles")
const { bunArgs, argv } = splitBunRuntimeFlags(process.argv.slice(2), profileDir, process.cwd())
if (bunArgs.some((arg) => arg.startsWith("--cpu-prof"))) {
  console.log(`${LOG_PREFIX} profiling: CPU profile and heap snapshot go to ${profileDir} when the server stops`)
}
// The original argv only applies to the first spawn: a `pair <code>` launch
// must not replay the (single-use) pairing on update restarts.
let currentArgv = argv
let suppressOpenOnNextChild = false
let skipUpdateOnNextChild = false
let lastStartupUpdateRestart = false

while (true) {
  const result = await spawnChild(currentArgv)
  if (orphaned) process.exit(0)
  currentArgv = sanitizeRestartArgv(currentArgv)
  if (shouldRestartCliProcess(result.code, result.signal)) {
    const isStartupUpdate = result.signal === null && result.code === CLI_STARTUP_UPDATE_RESTART_EXIT_CODE

    // Guard against infinite restart loops: if two consecutive startup-update
    // restarts happen it means the installed update did not change the binary
    // that actually runs (e.g. when launched via `bunx`, which maintains its
    // own package cache). Skip the self-update on the next spawn so the child
    // proceeds normally instead of trying to update again.
    if (isStartupUpdate && lastStartupUpdateRestart) {
      console.log(`${LOG_PREFIX} update installed but the running binary did not change, continuing with current version`)
      skipUpdateOnNextChild = true
      lastStartupUpdateRestart = false
    } else {
      lastStartupUpdateRestart = isStartupUpdate
    }

    suppressOpenOnNextChild = isUiUpdateRestart(result.code, result.signal)
    console.log(`${LOG_PREFIX} supervisor restarting ${CLI_COMMAND} in the same terminal session`)
    continue
  }

  process.exit(result.code ?? (result.signal ? 1 : 0))
}
