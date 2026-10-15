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

export function createNativeProviderTokenSingleflight<T>() {
  const inflight = new Map<AdminProviderId, Map<string, Promise<T>>>()
  return (provider: AdminProviderId, options: NativeProviderTokenRequest, action: () => Promise<T>): Promise<T> => {
    const key = `${options.forceRefresh === true}:${options.previousAccountId ?? ""}`
    const requests = inflight.get(provider) ?? new Map<string, Promise<T>>()
    inflight.set(provider, requests)
    const existing = requests.get(key)
    if (existing) return existing
    const pending = action().finally(() => {
      if (requests.get(key) === pending) requests.delete(key)
      if (requests.size === 0 && inflight.get(provider) === requests) inflight.delete(provider)
    })
    requests.set(key, pending)
    return pending
  }
}

/** Keeps administrator CLI OAuth state under a gateway-owned, isolated HOME. */
export function createAdminProviderControl({
  homeDir,
  createAuthDeps = createProcessAuthDeps,
  resolveCommandPath: resolveCommandPathImpl = resolveCommandPath,
}: {
  homeDir: string
  createAuthDeps?: typeof createProcessAuthDeps
  resolveCommandPath?: typeof resolveCommandPath
}) {
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
  const singleflightNativeToken = createNativeProviderTokenSingleflight<NativeProviderTokenData>()
  const nativeTokenEpoch = new Map<AdminProviderId, number>([["codex", 0], ["claude", 0]])
  let manager: ProviderAuthManager | null = null
  let managerPromise: Promise<ProviderAuthManager> | null = null
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
    if (managerPromise) return managerPromise
    managerPromise = (async () => {
    // Codex and Claude expect their config roots to exist before the first
    // status probe. mkdir leaves existing directories and credentials intact.
    for (const directory of [homeDir, env.CODEX_HOME, env.CLAUDE_CONFIG_DIR]) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
    }
    const deps = createAuthDeps()
    const baseExec = deps.exec
    const baseSpawn = deps.spawnStreaming
    const created = new ProviderAuthManager({
      ...deps,
      resolveCommandPath: (command) => resolveCommandPathImpl(command, homeDir),
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
    await Promise.all([created.probeService("codex"), created.probeService("claude")])
    manager = created
    return created
    })().finally(() => { managerPromise = null })
    return managerPromise
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
    start(provider: AdminProviderId) {
      bumpNativeTokenEpoch(provider)
      return withProviderLock(provider, async () => {
        const current = await getManager()
        await current.cancelLoginAndWait(service(provider))
        current.startLogin(service(provider))
      })
    },
    submit(provider: AdminProviderId, code: string) {
      bumpNativeTokenEpoch(provider)
      return withProviderLock(provider, async () => (await getManager()).submitLoginCode(service(provider), code))
    },
    cancel(provider: AdminProviderId) {
      bumpNativeTokenEpoch(provider)
      return withProviderLock(provider, async () => (await getManager()).cancelLoginAndWait(service(provider)))
    },
    async install(provider: AdminProviderId) {
      const current = await getManager()
      if (provider === "codex") return current.install("codex")
      const deps = createAuthDeps()
      const result = await deps.exec(["bun", "add", "--global", `@anthropic-ai/claude-code@${claudeCodeMinimumVersion()}`], { env, timeoutMs: 10 * 60_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Claude Code installation failed.")
      await current.probeService("claude")
    },
    async logout(provider: AdminProviderId) {
      bumpNativeTokenEpoch(provider)
      const current = await getManager()
      await withProviderLock(provider, async () => {
        await current.cancelLoginAndWait(service(provider))
        const result = await createAuthDeps().exec(
          provider === "codex" ? ["codex", "logout"] : ["claude", "auth", "logout"],
          { env },
        )
        if (result.code !== 0) throw new Error(`${provider} logout failed`)
        await current.probeService(service(provider))
      })
    },
    getNativeToken(provider: AdminProviderId, options: NativeProviderTokenRequest): Promise<NativeProviderTokenData> {
      const epoch = nativeTokenEpoch.get(provider) ?? 0
      return singleflightNativeToken(provider, options, () => withProviderLock(provider, async () => {
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
          if (nativeTokenEpoch.get(provider) !== epoch) throw new Error("Native provider sign-in required")
          return token
        } catch (error) {
          if (error instanceof NativeProviderAccountChangedError) throw error
          throw new Error("Native provider sign-in required")
        }
      }))
    },
  }

  function bumpNativeTokenEpoch(provider: AdminProviderId) {
    nativeTokenEpoch.set(provider, (nativeTokenEpoch.get(provider) ?? 0) + 1)
  }
}
