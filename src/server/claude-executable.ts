/**
 * Which `claude` runs Kanna's Claude turns: the one the user installed, the
 * same way codex, cursor-agent and grok run from the user's install.
 *
 * The Agent SDK ships its own copy of Claude Code (the platform package
 * @anthropic-ai/claude-agent-sdk-<os>-<arch>) and runs it unless handed a
 * path. That copy is pinned to the SDK version, so turns ran a different
 * Claude Code than the provider card's `claude auth status`, family aliases
 * like "opus" resolved to whatever that older copy knew, and wrappers on
 * PATH were skipped. The SDK is only the wire protocol here; the binary is
 * the user's.
 *
 * The SDK does no version handshake: an older CLI handed an option it does
 * not know exits with "unknown option" partway into a turn. So a CLI older
 * than the one the SDK was built against counts as outdated, and the
 * provider card offers `claude update`.
 */

import { statSync } from "node:fs"
import { homedir } from "node:os"
// Read at build time: the published server is a bundle with the SDK inlined
// (scripts/build-server.ts), so there's no SDK folder on disk to look in. By
// path, because the SDK's `exports` doesn't list package.json.
import sdkPackage from "../../node_modules/@anthropic-ai/claude-agent-sdk/package.json" with { type: "json" }
import { compareVersions } from "./cli-runtime"
import { resolveCommandPath } from "./process-utils"

/** Set to a wrapper script (Bedrock, Foundry…) to run it instead of `claude`. */
export const CLAUDE_EXECUTABLE_ENV_VAR = "CLAUDE_EXECUTABLE"

export const CLAUDE_INSTALL_HINT =
  "Install Claude Code from Settings → Providers, or run `curl -fsSL https://claude.ai/install.sh | bash`."

export type ClaudeExecutable =
  | { ok: true; path: string; version: string | null }
  | { ok: false; reason: "not_installed"; message: string }
  | { ok: false; reason: "outdated"; message: string; path: string; version: string }

/**
 * The Claude Code version this Agent SDK was built against (its
 * `claudeCodeVersion`; SDK 0.3.N pairs with Claude Code 2.1.N).
 */
export function claudeCodeMinimumVersion(): string {
  const version = (sdkPackage as { claudeCodeVersion?: unknown }).claudeCodeVersion
  return typeof version === "string" ? version : "0.0.0"
}

/** `CLAUDE_EXECUTABLE`, with a leading ~ expanded (the SDK spawns it verbatim). */
export function claudeExecutableOverride(env: Record<string, string | undefined> = process.env): string | null {
  const value = env[CLAUDE_EXECUTABLE_ENV_VAR]?.trim()
  return value ? value.replace(/^~(?=\/|$)/, homedir()) : null
}

/** "2.1.280 (Claude Code)" → "2.1.280". */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(output)?.[1] ?? null
}

export function isClaudeVersionSupported(version: string, minimum = claudeCodeMinimumVersion()) {
  return compareVersions(version, minimum) >= 0
}

export function outdatedClaudeMessage(version: string, minimum = claudeCodeMinimumVersion()) {
  return `Claude Code ${version} is older than Kanna supports (${minimum} or newer). Update it from Settings → Providers, or run \`claude update\`.`
}

export interface ResolveClaudeExecutableDeps {
  env?: Record<string, string | undefined>
  resolveCommandPath?: (command: string) => string | null
  readVersion?: (binaryPath: string) => Promise<string | null>
  minimumVersion?: string
}

/**
 * `claude --version` costs a process start, so it runs once per binary and
 * again only when the file changes (an update replaces it).
 */
const versionCache = new Map<string, { mtimeMs: number; version: string | null }>()

async function readClaudeVersion(binaryPath: string): Promise<string | null> {
  let mtimeMs = -1
  try {
    mtimeMs = statSync(binaryPath).mtimeMs
  } catch {
    // Unreadable: run it anyway and let the spawn report the problem.
  }
  const cached = versionCache.get(binaryPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached.version

  const child = Bun.spawn([binaryPath, "--version"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timeout = setTimeout(() => child.kill(), 15_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  await child.exited
  clearTimeout(timeout)
  const version = parseClaudeVersion(`${stdout}\n${stderr}`)
  versionCache.set(binaryPath, { mtimeMs, version })
  return version
}

export async function resolveClaudeExecutable(deps: ResolveClaudeExecutableDeps = {}): Promise<ClaudeExecutable> {
  // An explicit override is trusted as-is: wrappers often don't answer
  // --version the way claude does.
  const override = claudeExecutableOverride(deps.env)
  if (override) return { ok: true, path: override, version: null }

  const binaryPath = (deps.resolveCommandPath ?? resolveCommandPath)("claude")
  if (!binaryPath) {
    return { ok: false, reason: "not_installed", message: `Claude Code isn't installed. ${CLAUDE_INSTALL_HINT}` }
  }

  const version = await (deps.readVersion ?? readClaudeVersion)(binaryPath)
  const minimum = deps.minimumVersion ?? claudeCodeMinimumVersion()
  // An unreadable version is let through: the turn's own error is more
  // useful than a guess.
  if (version && !isClaudeVersionSupported(version, minimum)) {
    return { ok: false, reason: "outdated", message: outdatedClaudeMessage(version, minimum), path: binaryPath, version }
  }
  return { ok: true, path: binaryPath, version }
}

/** The path to hand the SDK, or an Error that explains what to do. */
export async function requireClaudeExecutable(deps?: ResolveClaudeExecutableDeps): Promise<string> {
  const resolved = await resolveClaudeExecutable(deps)
  if (!resolved.ok) throw new Error(resolved.message)
  return resolved.path
}
