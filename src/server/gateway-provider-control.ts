import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { AuthLoginFlowState, AuthServiceId } from "../shared/types"
import type { NativeProviderTokenData, NativeProviderTokenRequest } from "../shared/gateway-api"
import { createProcessAuthDeps, ProviderAuthManager } from "./provider-auth"
import { fetchLatestPackageVersion } from "./cli-runtime"
import { DEFAULT_OPENAI_SDK_MODEL } from "../shared/types"
import { resolveCommandPath } from "./process-utils"
import { claudeCodeMinimumVersion } from "./claude-executable"
import { createNativeProviderTokenController, NativeProviderAccountChangedError } from "./gateway/native-provider-token"

export type AdminProviderId = "codex" | "claude"

export interface AdminProviderAuthStatus {
  id: AdminProviderId
  installed: boolean
  authStatus: string
  shareable: boolean
  flow: AuthLoginFlowState
}

/** Keeps administrator CLI OAuth state under a gateway-owned, isolated HOME. */
export function createAdminProviderControl({ homeDir }: { homeDir: string }) {
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
    BUN_INSTALL: path.join(homeDir, ".bun"),
    OPENAI_API_KEY: "",
    CODEX_API_KEY: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    ANTHROPIC_BASE_URL: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    PATH: `${path.join(homeDir, ".bun", "bin")}:${path.join(homeDir, ".local", "bin")}:${process.env.PATH ?? ""}`,
  }
  const nativeTokens = createNativeProviderTokenController({ homeDir, env })
  const providerLocks = new Map<AdminProviderId, Promise<void>>()
  let manager: ProviderAuthManager | null = null
  let statusesCheckedAt = 0
  let statusRefresh: Promise<void> | null = null

  async function withProviderLock<T>(provider: AdminProviderId, action: () => Promise<T> | T): Promise<T> {
    const previous = providerLocks.get(provider) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    providerLocks.set(provider, current)
    await previous
    try { return await action() }
    finally {
      release()
      if (providerLocks.get(provider) === current) providerLocks.delete(provider)
    }
  }

  async function getManager() {
    if (manager) return manager
    await mkdir(homeDir, { recursive: true, mode: 0o700 })
    const deps = createProcessAuthDeps()
    const baseExec = deps.exec
    const baseSpawn = deps.spawnStreaming
    manager = new ProviderAuthManager({
      ...deps,
      resolveCommandPath: (command) => resolveCommandPath(command, homeDir),
      exec: (argv, opts) => baseExec(argv, { ...opts, env: { ...env, ...opts?.env } }),
      spawnStreaming: (argv, opts) => baseSpawn(argv, { ...opts, env: { ...env, ...opts?.env } }),
      spawnPty: (argv) => {
        // ProviderAuthManager's PTY dependency has no env argument. Wrap HOME
        // for this dedicated process so Claude's browser login cannot touch the
        // gateway host account's credentials.
        if (typeof Bun.Terminal !== "function") throw new Error("Bun PTY support is required for isolated Claude sign-in.")
        const listeners = new Set<(chunk: string) => void>()
        const terminal = new Bun.Terminal({ cols: 200, rows: 50, name: "xterm-256color", data: (_term, data) => {
          for (const listener of listeners) listener(Buffer.from(data).toString("utf8"))
        } })
        const proc = Bun.spawn(argv, { terminal, env: { ...process.env, ...env, TERM: "xterm-256color" } })
        void proc.exited.finally(() => terminal.close()).catch(() => undefined)
        return {
          onOutput: (listener: (chunk: string) => void) => { listeners.add(listener) },
          exited: proc.exited,
          kill: () => { try { proc.kill() } catch {} },
          write: (data: string) => { try { terminal.write(data) } catch {} },
        }
      },
      readLlmProvider: async () => ({
        provider: "openai", apiKey: "", model: DEFAULT_OPENAI_SDK_MODEL,
        baseUrl: "", resolvedBaseUrl: "https://api.openai.com/v1", faveModels: [],
        enabled: false, warning: null, filePathDisplay: "",
      }),
      writeLlmProvider: async () => { throw new Error("Admin OAuth does not configure a shared model connection.") },
      fetchLatestNpmVersion: fetchLatestPackageVersion,
    })
    await Promise.all([manager.probeService("codex"), manager.probeService("claude")])
    return manager
  }

  function service(provider: AdminProviderId): AuthServiceId { return provider }

  return {
    async getStatuses(): Promise<AdminProviderAuthStatus[]> {
      const current = await getManager()
      if (Date.now() - statusesCheckedAt >= 5_000) {
        if (!statusRefresh) {
          statusRefresh = Promise.all([current.probeService("codex"), current.probeService("claude")])
            .then(() => { statusesCheckedAt = Date.now() })
            .finally(() => { statusRefresh = null })
        }
        await statusRefresh
      }
      return (["codex", "claude"] as const).map((id) => {
        const value = current.getSnapshot().services.find((item) => item.service === id)!
        return { id, installed: value.installed, authStatus: value.authStatus, shareable: false, flow: value.login }
      })
    },
    async start(provider: AdminProviderId) { await withProviderLock(provider, async () => (await getManager()).startLogin(service(provider))) },
    async submit(provider: AdminProviderId, code: string) { await withProviderLock(provider, async () => (await getManager()).submitLoginCode(service(provider), code)) },
    async cancel(provider: AdminProviderId) { await withProviderLock(provider, async () => (await getManager()).cancelLogin(service(provider))) },
    async install(provider: AdminProviderId) {
      const current = await getManager()
      if (provider === "codex") return current.install("codex")
      const deps = createProcessAuthDeps()
      const result = await deps.exec(["bun", "add", "--global", `@anthropic-ai/claude-code@${claudeCodeMinimumVersion()}`], { env, timeoutMs: 10 * 60_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Claude Code installation failed.")
      await current.probeService("claude")
    },
    async logout(provider: AdminProviderId) {
      const current = await getManager()
      await withProviderLock(provider, async () => {
        const result = await createProcessAuthDeps().exec(
          provider === "codex" ? ["codex", "logout"] : ["claude", "auth", "logout"],
          { env },
        )
        if (result.code !== 0) throw new Error(`${provider} logout failed`)
        await current.probeService(service(provider))
      })
    },
    async getNativeToken(provider: AdminProviderId, options: NativeProviderTokenRequest): Promise<NativeProviderTokenData> {
      return withProviderLock(provider, async () => {
        const current = await getManager()
        const serviceId = service(provider)
        if (current.getSnapshot().services.find((item) => item.service === serviceId)?.login.phase !== "idle") {
          throw new Error("Native provider sign-in required")
        }
        await current.probeService(serviceId)
        if (current.getSnapshot().services.find((item) => item.service === serviceId)?.authStatus !== "signed_in") {
          throw new Error("Native provider sign-in required")
        }
        try {
          const token = await nativeTokens.getToken(provider, options)
          await current.probeService(serviceId)
          if (current.getSnapshot().services.find((item) => item.service === serviceId)?.authStatus !== "signed_in") {
            throw new Error("Native provider sign-in required")
          }
          return token
        } catch (error) {
          if (error instanceof NativeProviderAccountChangedError) throw error
          throw new Error("Native provider sign-in required")
        }
      })
    },
  }
}
