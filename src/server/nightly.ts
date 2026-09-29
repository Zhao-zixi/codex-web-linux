import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { LOG_PREFIX } from "../shared/branding"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { hasCommand } from "./process-utils"
import { CLI_CHILD_MODE, CLI_CHILD_MODE_ENV_VAR } from "./restart"

// Nightly channel: build the repo's main branch from source and install it as
// the global CLI, so clients can jump to unreleased changes without waiting
// for an npm release. The install reuses the normal update restart flow — the
// supervisor respawns the global bin, which `bun install -g .` just replaced.

const NIGHTLY_REPO = "jakemor/kanna"
const STEP_TIMEOUT_MS = 10 * 60 * 1000
const OUTPUT_TAIL_CHARS = 2_000

export interface NightlyInstallResult extends UpdateInstallAttemptResult {
  /** The stamped version of the installed build ("0.56.7-nightly.abc1234"), null on failure. */
  version: string | null
}

export interface RunCommandResult {
  ok: boolean
  output: string
}

export interface NightlyBuildDeps {
  log?: (message: string) => void
  fetchImpl?: typeof fetch
  /** Command runner seam for tests; the default spawns with a hard timeout. */
  runCommand?: (command: string, args: string[], cwd: string, env?: Record<string, string>) => Promise<RunCommandResult>
  /** Working directory override for tests (default ~/.kanna/nightly). */
  workDir?: string
  /** Bun global dir override for tests (default $BUN_INSTALL or ~/.bun). */
  bunGlobalDir?: string
}

/** Version string stamped onto nightly builds: "<base>-nightly.<short-sha>". */
export function nightlyVersion(baseVersion: string, sha: string): string {
  return `${baseVersion}-nightly.${sha.slice(0, 7)}`
}

export async function fetchMainCommitSha(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`https://api.github.com/repos/${NIGHTLY_REPO}/commits/main`, {
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
    headers: {
      Accept: "application/vnd.github.sha",
      "User-Agent": "kanna",
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for the main branch`)
  }
  const sha = (await response.text()).trim()
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("GitHub did not return a commit sha for main")
  }
  return sha.toLowerCase()
}

function runCommandWithTimeout(command: string, args: string[], cwd: string, env?: Record<string, string>): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    let output = ""
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok, output })
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    const timer = setTimeout(() => {
      output += `\n[timed out after ${STEP_TIMEOUT_MS / 60_000} minutes]`
      child.kill("SIGKILL")
      finish(false)
    }, STEP_TIMEOUT_MS)

    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString() })
    child.once("error", (error) => {
      output += `\n${error.message}`
      finish(false)
    })
    child.once("exit", (code) => {
      finish(code === 0)
    })
  })
}

function failure(userMessage: string): NightlyInstallResult {
  return {
    ok: false,
    errorCode: "install_failed",
    userTitle: "Nightly update failed",
    userMessage,
    version: null,
  }
}

function outputTail(output: string): string {
  const trimmed = output.trim()
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed
}

function bunGlobalDir(): string {
  return process.env.BUN_INSTALL || path.join(homedir(), ".bun")
}

/**
 * Strip corrupt entries from Bun's global package manifest. Kanna 0.57.0's
 * nightly install ran `bun install -g .`, which Bun mis-parses: it installs
 * nothing but records a junk dependency (key "" or "@", value "." / "@.").
 * While one is present, Bun refuses EVERY further global install with a
 * DependencyLoop error — including the stable auto-update — so both the
 * nightly and stable installers repair the manifest first.
 * Returns true when the manifest was repaired.
 */
export function repairBunGlobalManifest(globalDir = bunGlobalDir()): boolean {
  const manifestPath = path.join(globalDir, "install", "global", "package.json")
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { dependencies?: Record<string, unknown> }
    const dependencies = manifest.dependencies
    if (!dependencies) return false
    let repaired = false
    for (const [name, value] of Object.entries(dependencies)) {
      const junkName = name === "" || name === "@"
      const junkValue = typeof value === "string" && /^(?:@|file:)?\.$/.test(value)
      if (junkName || junkValue) {
        delete dependencies[name]
        repaired = true
      }
    }
    if (repaired) {
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n")
    }
    return repaired
  } catch {
    // Missing or unreadable manifest — nothing to repair.
    return false
  }
}

/**
 * Download main from GitHub, build it from source, and install it as the
 * global CLI. The build's version is stamped "<base>-nightly.<short-sha>" so
 * the UI shows what's running; the base version keeps ordering against npm,
 * so the next published release upgrades a nightly back to stable normally.
 */
export async function installNightlyBuild(deps: NightlyBuildDeps = {}): Promise<NightlyInstallResult> {
  const log = deps.log ?? (() => {})
  const fetchImpl = deps.fetchImpl ?? fetch
  const runCommand = deps.runCommand ?? runCommandWithTimeout

  if (!hasCommand("tar")) {
    return failure("Kanna needs the `tar` command to unpack the nightly source.")
  }
  if (!hasCommand("bun")) {
    return failure("Kanna could not find Bun to build the nightly version.")
  }

  let sha: string
  try {
    sha = await fetchMainCommitSha(fetchImpl)
  } catch (error) {
    return failure(`Could not resolve the latest main commit: ${error instanceof Error ? error.message : String(error)}`)
  }
  log(`${LOG_PREFIX} nightly: building ${NIGHTLY_REPO}@${sha.slice(0, 7)}`)

  const workDir = deps.workDir ?? path.join(homedir(), ".kanna", "nightly")
  const srcDir = path.join(workDir, "src")
  const tarPath = path.join(workDir, "source.tar.gz")
  try {
    if (existsSync(srcDir)) rmSync(srcDir, { recursive: true, force: true })
    mkdirSync(srcDir, { recursive: true })

    const tarball = await fetchImpl(`https://codeload.github.com/${NIGHTLY_REPO}/tar.gz/${sha}`, {
      headers: { "User-Agent": "kanna" },
    })
    if (!tarball.ok) {
      return failure(`GitHub returned ${tarball.status} downloading the source archive.`)
    }
    writeFileSync(tarPath, Buffer.from(await tarball.arrayBuffer()))
  } catch (error) {
    return failure(`Could not download the source archive: ${error instanceof Error ? error.message : String(error)}`)
  }

  const extract = await runCommand("tar", ["-xzf", tarPath, "-C", srcDir, "--strip-components=1"], workDir)
  rmSync(tarPath, { force: true })
  if (!extract.ok) {
    return failure(`Could not unpack the source archive.\n${outputTail(extract.output)}`)
  }

  // Stamp the build's identity before installing so the running version and
  // the global package both carry the commit.
  let version: string
  let packageName: string
  try {
    const packageJsonPath = path.join(srcDir, "package.json")
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: string; version?: string }
    packageName = packageJson.name ?? "kanna-code"
    version = nightlyVersion(packageJson.version ?? "0.0.0", sha)
    writeFileSync(packageJsonPath, JSON.stringify({ ...packageJson, version }, null, 2) + "\n")
  } catch (error) {
    return failure(`Could not stamp the nightly version: ${error instanceof Error ? error.message : String(error)}`)
  }

  const steps: Array<{ label: string; command: string; args: string[] }> = [
    { label: "install dependencies", command: "bun", args: ["install"] },
    { label: "build", command: "bun", args: ["run", "build"] },
  ]
  for (const step of steps) {
    log(`${LOG_PREFIX} nightly: ${step.label}…`)
    const result = await runCommand(step.command, step.args, srcDir)
    if (!result.ok) {
      return failure(`Nightly ${step.label} step failed.\n${outputTail(result.output)}`)
    }
  }

  // Startup probe BEFORE replacing the global install: `--version` in child
  // mode loads the entire server module graph, so a main that can't even
  // start never reaches users' PATH — the current install stays untouched.
  // It runs the bundle the install will ship (scripts/build-server.ts), not
  // the source bin/kanna prefers in a checkout.
  log(`${LOG_PREFIX} nightly: verifying the build…`)
  const probe = await runCommand("bun", ["dist/server/entry.js", "--version"], srcDir, {
    [CLI_CHILD_MODE_ENV_VAR]: CLI_CHILD_MODE,
    KANNA_DISABLE_SELF_UPDATE: "1",
  })
  if (!probe.ok || !probe.output.includes(version)) {
    return failure(`The nightly build failed its startup check, so it was not installed.\n${outputTail(probe.output)}`)
  }

  // Install via a packed tarball with an absolute path — `bun install -g .`
  // mis-parses the bare dot (installs nothing, corrupts the global manifest).
  if (repairBunGlobalManifest(deps.bunGlobalDir)) {
    log(`${LOG_PREFIX} nightly: repaired a corrupt bun global manifest`)
  }
  log(`${LOG_PREFIX} nightly: installing the build…`)
  const pack = await runCommand("bun", ["pm", "pack"], srcDir)
  if (!pack.ok) {
    return failure(`Nightly pack step failed.\n${outputTail(pack.output)}`)
  }
  const packedTarball = path.join(srcDir, `${packageName}-${version}.tgz`)
  if (!existsSync(packedTarball)) {
    return failure(`Nightly pack step did not produce ${path.basename(packedTarball)}.\n${outputTail(pack.output)}`)
  }
  // Bun refuses to switch an installed registry package to a tarball spec in
  // place (DependencyLoop), so drop the existing global entry first — the
  // package may not be installed globally, so a remove failure is fine. Any
  // failure past this point rolls back to the latest release so the machine
  // is never left without a global install. (The reverse direction — a
  // registry install over a tarball entry — works in place, so the stable
  // updater needs no such dance.)
  await runCommand("bun", ["remove", "-g", packageName], srcDir)
  const rollbackFailure = async (message: string) => {
    const rollback = await runCommand("bun", ["install", "-g", `${packageName}@latest`], srcDir)
    return failure(`${message}${rollback.ok ? `\nThe latest ${packageName} release was reinstalled.` : `\nRestoring the release also failed — run \`bun install -g ${packageName}@latest\` to recover.`}`)
  }
  const install = await runCommand("bun", ["install", "-g", packedTarball], srcDir)
  if (!install.ok) {
    return rollbackFailure(`Nightly install step failed.\n${outputTail(install.output)}`)
  }

  // `bun install -g` can exit 0 without replacing the package (that's how
  // 0.57.0's dot-path install silently no-opped) — trust only the installed
  // manifest reporting the stamped version.
  try {
    const installedManifestPath = path.join(
      deps.bunGlobalDir ?? bunGlobalDir(),
      "install", "global", "node_modules", packageName, "package.json"
    )
    const installedVersion = (JSON.parse(readFileSync(installedManifestPath, "utf8")) as { version?: string }).version
    if (installedVersion !== version) {
      return await rollbackFailure(`The install finished but the global package still reports ${installedVersion ?? "no version"} instead of ${version}.`)
    }
  } catch (error) {
    return await rollbackFailure(`Could not verify the installed build: ${error instanceof Error ? error.message : String(error)}`)
  }

  log(`${LOG_PREFIX} nightly: installed ${version}`)
  return {
    ok: true,
    errorCode: null,
    userTitle: null,
    userMessage: null,
    version,
  }
}
