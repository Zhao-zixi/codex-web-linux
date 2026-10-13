import path from "node:path"
import { mkdir } from "node:fs/promises"
import type { AuthLoginFlowState, AuthServiceId } from "../shared/types"
import { createProcessAuthDeps, ProviderAuthManager } from "./provider-auth"
import { fetchLatestPackageVersion } from "./cli-runtime"
import { DEFAULT_OPENAI_SDK_MODEL } from "../shared/types"
import { resolveCommandPath } from "./process-utils"
import { claudeCodeMinimumVersion } from "./claude-executable"

export type AdminProviderId = "codex" | "claude"

export interface AdminProviderAuthStatus {
  id: AdminProviderId
  installed: boolean
  authStatus: string
  shareable: false
  flow: AuthLoginFlowState
}

/** Keeps administrator CLI OAuth state under a gateway-owned, isolated HOME. */
export function createAdminProviderControl({ homeDir }: { homeDir: string }) {
  const env = {
    HOME: homeDir,
    CODEX_HOME: path.join(homeDir, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(homeDir, ".claude"),
    BUN_INSTALL: path.join(homeDir, ".bun"),
    PATH: `${path.join(homeDir, ".bun", "bin")}:${path.join(homeDir, ".local", "bin")}:${process.env.PATH ?? ""}`,
  }
  let manager: ProviderAuthManager | null = null

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
      return (["codex", "claude"] as const).map((id) => {
        const value = current.getSnapshot().services.find((item) => item.service === id)!
        return { id, installed: value.installed, authStatus: value.authStatus, shareable: false, flow: value.login }
      })
    },
    async start(provider: AdminProviderId) { (await getManager()).startLogin(service(provider)) },
    async submit(provider: AdminProviderId, code: string) { (await getManager()).submitLoginCode(service(provider), code) },
    async cancel(provider: AdminProviderId) { (await getManager()).cancelLogin(service(provider)) },
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
      const result = await createProcessAuthDeps().exec(
        provider === "codex" ? ["codex", "logout"] : ["claude", "auth", "logout"],
        { env },
      )
      if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${provider} logout failed`)
      await current.probeService(service(provider))
    },
  }
}
