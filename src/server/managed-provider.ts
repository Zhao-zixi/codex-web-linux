export type ManagedProviderId = "codex" | "claude"

export interface ManagedProviderConnection {
  id: string
  name: string
  provider: ManagedProviderId
  kind: "api_key" | "native"
  baseUrl?: string
  accessToken?: string
  expiresAt?: number
  chatgptAccountId?: string
  chatgptPlanType?: string
  getToken?: (forceRefresh?: boolean) => Promise<{ accessToken: string; expiresAt: number; chatgptAccountId?: string; chatgptPlanType?: string }>
}

export interface ProviderAccessSnapshot {
  assigned: ManagedProviderConnection[]
  selfFirst: true
}

export async function resolveManagedProvider(provider: ManagedProviderId, options: {
  homeDir: string
  projectDir: string
  gatewayUrl?: string
  accountToken?: string
  env?: Record<string, string | undefined>
  fetchFn?: typeof fetch
}): Promise<ManagedProviderConnection | null> {
  if (await hasOwnProviderCredentials(provider, options)) return null
  const access = await getManagedProviderAccess(options)
  const candidates = access.assigned.filter((connection) => connection.provider === provider)
  // Preserve self-first, then prefer an assigned official CLI profile over API credentials.
  const connection = candidates.find((item) => item.kind === "native") ?? candidates.find((item) => item.kind === "api_key")
  if (!connection || connection.kind === "api_key") return connection ?? null
  const gatewayUrl = (options.gatewayUrl ?? process.env.KANNA_GATEWAY_URL ?? "").replace(/\/$/, "")
  const accountToken = options.accountToken ?? process.env.KANNA_GATEWAY_ACCOUNT_TOKEN ?? ""
  if (!gatewayUrl || !accountToken) return null
  let currentAccountId: string | undefined
  const getToken = async (forceRefresh = false) => {
    const response = await (options.fetchFn ?? fetch)(`${gatewayUrl}/internal/providers/${connection.id}/native-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accountToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ forceRefresh, ...(connection.provider === "codex" && currentAccountId ? { previousAccountId: currentAccountId } : {}) }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`Managed provider token is unavailable (${response.status}).`)
    const value = await response.json() as { connectionId?: string; provider?: string; accessToken?: string; expiresAt?: number; chatgptAccountId?: string; chatgptPlanType?: string }
    if (value.connectionId !== connection.id || value.provider !== provider || typeof value.accessToken !== "string" || !value.accessToken || typeof value.expiresAt !== "number") {
      throw new Error("Managed provider returned an invalid native token.")
    }
    if (connection.provider === "codex" && typeof value.chatgptAccountId !== "string") throw new Error("Managed Codex account identity is missing.")
    if (connection.provider === "codex" && currentAccountId && currentAccountId !== value.chatgptAccountId) throw new Error("Managed Codex account identity changed.")
    currentAccountId = value.chatgptAccountId
    return { accessToken: value.accessToken, expiresAt: value.expiresAt, chatgptAccountId: value.chatgptAccountId, chatgptPlanType: value.chatgptPlanType }
  }
  const token = await getToken()
  return { ...connection, ...token, getToken }
}

/** Read the account-scoped grant list from the gateway using its revocable proxy token. */
export async function getManagedProviderAccess(options: {
  gatewayUrl?: string
  accountToken?: string
  fetchFn?: typeof fetch
} = {}): Promise<ProviderAccessSnapshot> {
  const gatewayUrl = (options.gatewayUrl ?? process.env.KANNA_GATEWAY_URL ?? "").replace(/\/$/, "")
  const accountToken = options.accountToken ?? process.env.KANNA_GATEWAY_ACCOUNT_TOKEN ?? ""
  if (!gatewayUrl || !accountToken) return { assigned: [], selfFirst: true }
  const response = await (options.fetchFn ?? fetch)(`${gatewayUrl}/internal/provider-access`, {
    headers: { Authorization: `Bearer ${accountToken}`, Accept: "application/json" },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`Managed provider access is unavailable (${response.status}).`)
  const value = await response.json() as Partial<ProviderAccessSnapshot>
  const assigned = Array.isArray(value.assigned) ? value.assigned.filter((item): item is ManagedProviderConnection =>
    Boolean(item && typeof item.id === "string" && typeof item.name === "string" &&
      (item.provider === "codex" || item.provider === "claude") &&
      (item.kind === "native" || item.kind === "api_key") &&
      (item.kind === "native" || typeof item.baseUrl === "string" && isGatewayProviderProxyUrl(item.baseUrl, item.provider)))
  ) : []
  return { assigned, selfFirst: true }
}

export function isGatewayProviderProxyUrl(value: string, provider: ManagedProviderId) {
  try {
    const url = new URL(value)
    const path = /^\/internal\/providers\/[a-f0-9]{32}(\/v1)?$/i.test(url.pathname)
    const providerPath = provider === "codex" ? url.pathname.endsWith("/v1") : !url.pathname.endsWith("/v1")
    return url.protocol === "http:" && url.hostname === "gateway" && url.port === "3210" &&
      !url.username && !url.password && !url.search && !url.hash && path && providerPath
  } catch { return false }
}

/** Add broker credentials only after callers have established that self credentials are absent. */
export function managedProviderEnvironment(
  connection: ManagedProviderConnection,
  accountToken: string,
  inherited: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!accountToken) throw new Error("Managed provider token is missing.")
  if (!connection.baseUrl) throw new Error("Managed API base URL is missing.")
  const env = Object.fromEntries(Object.entries(inherited).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
  if (connection.provider === "claude") {
    env.ANTHROPIC_BASE_URL = connection.baseUrl.replace(/\/$/, "")
    env.ANTHROPIC_AUTH_TOKEN = accountToken
    delete env.ANTHROPIC_API_KEY
  }
  return env
}

export function managedCodexArguments(connection: ManagedProviderConnection): string[] {
  if (!connection.baseUrl) throw new Error("Managed API base URL is missing.")
  const quoteToml = (value: string) => JSON.stringify(value)
  return [
    "-c", "model_provider='kanna_managed'",
    "-c", `model_providers.kanna_managed.name=${quoteToml(connection.name)}`,
    "-c", `model_providers.kanna_managed.base_url=${quoteToml(connection.baseUrl.replace(/\/$/, ""))}`,
    "-c", "model_providers.kanna_managed.env_key='KANNA_GATEWAY_ACCOUNT_TOKEN'",
    "-c", "model_providers.kanna_managed.wire_api='responses'",
    "-c", "model_providers.kanna_managed.requires_openai_auth=false",
    "-c", "model_providers.kanna_managed.supports_websockets=false",
  ]
}

/** Detect credential material, not stale auth metadata; expired material remains user-owned. */
export async function hasOwnProviderCredentials(provider: ManagedProviderId, options: {
  homeDir: string
  projectDir?: string
  env?: Record<string, string | undefined>
}): Promise<boolean> {
  const env = options.env ?? process.env
  if (provider === "codex" && (env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim())) return true
  const cloudModes = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]
  const isTruthy = (value: unknown) => {
    if (value === true) return true
    if (typeof value === "number") return value !== 0
    return typeof value === "string" && value.trim() !== "" && !["0", "false", "no", "off"].includes(value.trim().toLowerCase())
  }
  if (provider === "claude" && (
    env.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_AUTH_TOKEN?.trim() || env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
    env.ANTHROPIC_BASE_URL?.trim() ||
    cloudModes.some((key) => isTruthy(env[key]))
  )) return true
  const files = await import("node:fs/promises")
  const unreadable = Symbol("unreadable")
  const readJson = async (file: string): Promise<Record<string, unknown> | null | typeof unreadable> => {
    try {
      const value = JSON.parse(await files.readFile(file, "utf8"))
      return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : unreadable
    }
  }
  if (provider === "codex") {
    const codexHome = env.CODEX_HOME || `${options.homeDir}/.codex`
    const auth = await readJson(`${codexHome}/auth.json`)
    if (auth === unreadable) return true
    if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) return true
    const tokens = auth?.tokens
    if (Boolean(tokens && typeof tokens === "object" && ["access_token", "refresh_token", "id_token"].some((key) => typeof (tokens as Record<string, unknown>)[key] === "string" && String((tokens as Record<string, unknown>)[key]).trim()))) return true
    for (const file of [`${codexHome}/config.toml`, ...(options.projectDir ? [`${options.projectDir}/.codex/config.toml`] : [])]) {
      let config: string
      try { config = await files.readFile(file, "utf8") }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        return true
      }
      if (hasCustomCodexProviderConfig(config, env.CODEX_PROFILE)) return true
    }
    return false
  }
  const claudeDir = env.CLAUDE_CONFIG_DIR || `${options.homeDir}/.claude`
  for (const file of [`${claudeDir}/.credentials.json`, `${claudeDir}/credentials.json`]) {
    const auth = await readJson(file)
    if (auth === unreadable) return true
    const oauth = auth?.claudeAiOauth
    if (oauth && typeof oauth === "object" && ["accessToken", "refreshToken"].some((key) => typeof (oauth as Record<string, unknown>)[key] === "string" && String((oauth as Record<string, unknown>)[key]).trim())) return true
  }
  const claudeSettings = [
    `${claudeDir}/settings.json`,
    `${claudeDir}/settings.local.json`,
    ...(options.projectDir ? [
      `${options.projectDir}/.claude/settings.json`,
      `${options.projectDir}/.claude/settings.local.json`,
    ] : []),
  ]
  for (const file of claudeSettings) {
    const settings = await readJson(file)
    if (settings === unreadable) return true
    if (typeof settings?.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) return true
    const localEnv = settings?.env
    if (localEnv && typeof localEnv === "object" && ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", ...cloudModes].some((key) => {
      const value = (localEnv as Record<string, unknown>)[key]
      return cloudModes.includes(key) ? isTruthy(value) : typeof value === "string" && value.trim() !== ""
    })) return true
  }
  return false
}

function hasCustomCodexProviderConfig(config: string, selectedProfile?: string) {
  const lines = config.split(/\r?\n/).map((line) => line.replace(/\s+#.*$/, "").trim()).filter(Boolean)
  let section = ""
  const values = new Map<string, string>()
  const customProviderNames = new Set<string>()
  const selectedProviders: string[] = []
  let configuredProfile: string | undefined
  for (const line of lines) {
    const heading = /^\[([^\]]+)\]$/.exec(line)
    if (heading) { section = heading[1]; continue }
    const entry = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line)
    if (!entry) continue
    const [, key, raw] = entry
    const value = raw.replace(/^(?:"([^"]*)"|'([^']*)').*$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? raw).trim()
    values.set(`${section}.${key}`, value)
    if (section === "" && key === "model_provider" && value && value !== "openai") selectedProviders.push(value)
    if (section === "" && key === "profile") configuredProfile = value
    const providerSection = /^model_providers\.([^.]+)$/.exec(section)
    if (providerSection && providerSection[1] !== "openai" && (key === "base_url" || key === "env_key")) customProviderNames.add(providerSection[1])
    if (providerSection?.[1] === "openai" && key === "env_key") customProviderNames.add("openai")
    if (providerSection?.[1] === "openai" && key === "base_url" && !/^"?https:\/\/api\.openai\.com\/v1\/?"?$/.test(value)) customProviderNames.add("openai")
  }
  if (customProviderNames.size > 0) return true
  if (selectedProviders.some((provider) => provider !== "openai")) return true
  const activeProfile = selectedProfile || configuredProfile
  if (activeProfile) {
    const profileProvider = values.get(`profiles.${activeProfile}.model_provider`)
    if (profileProvider && profileProvider !== "openai") return true
    const profileBaseUrl = values.get(`profiles.${activeProfile}.base_url`)
    if (profileBaseUrl) return true
  }
  return false
}

/** Broker routes are deliberately limited to official API operations. */
export function managedProviderPathAllowed(provider: ManagedProviderId, path: string) {
  const normalized = path.replace(/^\/+/, "")
  if (provider === "codex") return normalized === "responses"
  return normalized === "messages" || normalized === "messages/count_tokens"
}
