import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ManagedProvider, NativeProviderTokenData } from "../../shared/gateway-api"
import { resolveCommandPath } from "../process-utils"

const TOKEN_REFRESH_WINDOW_MS = 60_000
const CLI_TIMEOUT_MS = 30_000

export class NativeProviderAccountChangedError extends Error {
  constructor() {
    super("Native provider account changed")
    this.name = "NativeProviderAccountChangedError"
  }
}

interface ClaudeOAuthProfile {
  accessToken?: unknown
  refreshToken?: unknown
  scopes?: unknown
  expiresAt?: unknown
}

export interface NativeProviderTokenControllerDeps {
  now?: () => number
  codexToken?: (options: { homeDir: string; forceRefresh: boolean; previousAccountId?: string }) => Promise<Omit<Extract<NativeProviderTokenData, { provider: "codex" }>, "provider">>
  claudeRefresh?: (options: { homeDir: string; env: Record<string, string> }) => Promise<void>
}

/** Reads only the gateway's isolated admin profile and returns short-lived access tokens. */
export function createNativeProviderTokenController(args: {
  homeDir: string
  env: Record<string, string>
  deps?: NativeProviderTokenControllerDeps
}) {
  const now = args.deps?.now ?? Date.now
  const inflight = new Map<ManagedProvider, { key: string; promise: Promise<NativeProviderTokenData> }>()

  async function claudeProfile(): Promise<{ path: string; oauth: ClaudeOAuthProfile } | null> {
    const directory = args.env.CLAUDE_CONFIG_DIR || path.join(args.homeDir, ".claude")
    for (const file of [path.join(directory, ".credentials.json"), path.join(directory, "credentials.json")]) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8")) as { claudeAiOauth?: ClaudeOAuthProfile }
        if (parsed.claudeAiOauth && typeof parsed.claudeAiOauth === "object") return { path: file, oauth: parsed.claudeAiOauth }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Native Claude profile is unavailable")
      }
    }
    return null
  }

  async function getClaudeToken(forceRefresh: boolean): Promise<NativeProviderTokenData> {
    let profile = await claudeProfile()
    const token = typeof profile?.oauth.accessToken === "string" ? profile.oauth.accessToken : ""
    const expiresAt = normalizeExpiry(profile?.oauth.expiresAt)
    if (!forceRefresh && token && expiresAt > now() + TOKEN_REFRESH_WINDOW_MS) {
      return { provider: "claude", accessToken: token, expiresAt }
    }
    const refreshToken = typeof profile?.oauth.refreshToken === "string" ? profile.oauth.refreshToken : ""
    const scopes = Array.isArray(profile?.oauth.scopes) && profile.oauth.scopes.every((scope) => typeof scope === "string")
      ? profile.oauth.scopes.join(" ")
      : ""
    if (!refreshToken || !scopes) throw new Error("Native Claude sign-in required")
    await (args.deps?.claudeRefresh ?? refreshClaudeProfile)({
      homeDir: args.homeDir,
      env: {
        ...args.env,
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
        CLAUDE_CODE_OAUTH_SCOPES: scopes,
      },
    })
    profile = await claudeProfile()
    const renewedToken = typeof profile?.oauth.accessToken === "string" ? profile.oauth.accessToken : ""
    const renewedExpiry = normalizeExpiry(profile?.oauth.expiresAt) || jwtExpiry(renewedToken)
    if (!renewedToken || renewedExpiry <= now()) throw new Error("Native Claude sign-in required")
    return { provider: "claude", accessToken: renewedToken, expiresAt: renewedExpiry }
  }

  async function getCodexToken(forceRefresh: boolean, previousAccountId?: string): Promise<NativeProviderTokenData> {
    const result = args.deps?.codexToken
      ? await args.deps.codexToken({ homeDir: args.homeDir, forceRefresh, previousAccountId })
      : await refreshCodexProfile({ homeDir: args.homeDir, env: args.env, forceRefresh, previousAccountId })
    if (!result.accessToken || result.expiresAt <= now() || !result.chatgptAccountId) {
      throw new Error("Native Codex sign-in required")
    }
    return { provider: "codex", ...result }
  }

  function getToken(provider: ManagedProvider, options: { forceRefresh?: boolean; previousAccountId?: string } = {}): Promise<NativeProviderTokenData> {
      const current = inflight.get(provider)
      const key = `${options.forceRefresh === true}:${options.previousAccountId ?? ""}`
      if (current?.key === key) return current.promise
      if (current) return current.promise.then(() => getToken(provider, options))
      const pending = (provider === "codex"
        ? getCodexToken(options.forceRefresh === true, options.previousAccountId)
        : getClaudeToken(options.forceRefresh === true))
        .finally(() => { if (inflight.get(provider)?.promise === pending) inflight.delete(provider) })
      inflight.set(provider, { key, promise: pending })
      return pending
  }
  return { getToken }
}

function normalizeExpiry(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0
  return value < 10_000_000_000 ? value * 1000 : value
}

function jwtExpiry(token: string) {
  try {
    const payload = token.split(".")[1]
    if (!payload) return 0
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : 0
  } catch { return 0 }
}

async function refreshClaudeProfile(options: { homeDir: string; env: Record<string, string> }) {
  const binary = resolveCommandPath("claude", options.homeDir)
  if (!binary) throw new Error("Native Claude sign-in required")
  await runCli(binary, ["auth", "login"], options.env)
}

async function runCli(binary: string, argv: string[], env: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "ignore"] })
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL") } catch {}
      reject(new Error("Native provider sign-in required"))
    }, CLI_TIMEOUT_MS)
    child.once("error", () => {
      clearTimeout(timer)
      reject(new Error("Native provider sign-in required"))
    })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error("Native provider sign-in required"))
    })
  })
}

async function refreshCodexProfile(options: {
  homeDir: string
  env: Record<string, string>
  forceRefresh: boolean
  previousAccountId?: string
}): Promise<{ accessToken: string; expiresAt: number; chatgptAccountId: string; chatgptPlanType?: string }> {
  const binary = resolveCommandPath("codex", options.homeDir)
  if (!binary) throw new Error("Native Codex sign-in required")
  const child = spawn(binary, ["app-server"], {
    cwd: options.homeDir,
    env: { ...process.env, ...options.env },
    stdio: ["pipe", "pipe", "ignore"],
  })
  const input = child.stdin
  const output = child.stdout
  if (!input || !output) throw new Error("Native Codex sign-in required")
  let nextId = 0
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>()
  const lines = createInterface({ input: output })
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line) as { id?: unknown; result?: unknown; error?: unknown }
      if (typeof message.id !== "number") return
      const request = pending.get(message.id)
      if (!request) return
      pending.delete(message.id)
      if (message.error) request.reject(new Error("Native Codex sign-in required"))
      else request.resolve((message.result && typeof message.result === "object" ? message.result : {}) as Record<string, unknown>)
    } catch {}
  })
  const timeout = setTimeout(() => {
    for (const request of pending.values()) request.reject(new Error("Native Codex sign-in required"))
    pending.clear()
    try { child.kill("SIGKILL") } catch {}
  }, CLI_TIMEOUT_MS)
  const request = (method: string, params?: Record<string, unknown>) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    input.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`)
  })
  try {
    await request("initialize", { clientInfo: { name: "kanna_gateway", title: "Kanna Gateway", version: "1" }, capabilities: { experimentalApi: true } })
    input.write(`${JSON.stringify({ method: "initialized" })}\n`)
    const auth = await request("getAuthStatus", { includeToken: true, refreshToken: true })
    const authToken = typeof auth.authToken === "string" ? auth.authToken : ""
    if (!authToken || (auth.authMethod !== "chatgpt" && auth.authMethod !== "chatgptAuthTokens")) throw new Error("Native Codex sign-in required")
    const account = await request("account/read", { refreshToken: true })
    const accountValue = account.account && typeof account.account === "object" ? account.account as Record<string, unknown> : null
    const routing = account.workspaceRouting && typeof account.workspaceRouting === "object" ? account.workspaceRouting as Record<string, unknown> : null
    const chatgptAccountId = typeof routing?.chatgptAccountId === "string" ? routing.chatgptAccountId : ""
    const chatgptPlanType = typeof accountValue?.planType === "string" ? accountValue.planType : undefined
    const expiresAt = jwtExpiry(authToken)
    if (!chatgptAccountId || !expiresAt) throw new Error("Native Codex sign-in required")
    if (options.previousAccountId && options.previousAccountId !== chatgptAccountId) {
      throw new NativeProviderAccountChangedError()
    }
    return { accessToken: authToken, expiresAt, chatgptAccountId, ...(chatgptPlanType ? { chatgptPlanType } : {}) }
  } finally {
    clearTimeout(timeout)
    lines.close()
    try { child.kill("SIGKILL") } catch {}
  }
}
