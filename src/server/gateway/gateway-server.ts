import { randomBytes, timingSafeEqual } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import type { Server, ServerWebSocket } from "bun"
import { NativeProviderAccountChangedError } from "./native-provider-token"
import type {
  AdminGatewayStateResponse,
  AdminProviderAuthStatus,
  GatewayAuthStatusResponse,
  GatewayLoginRequest,
  GatewayLoginResponse,
  GatewayProviderAccessResponse,
  GatewayRole,
  GatewayUserSummary,
  InternalGatewayProviderAccessResponse,
  ManagedProvider,
  NativeProviderTokenRequest,
  NativeProviderTokenData,
  NativeProviderTokenResponse,
} from "../../shared/gateway-api"
import { GatewayStore } from "./gateway-store"

interface GatewayAccountConfig {
  id: string
  appUrl: string
  appPasswordFile: string
  accountTokenFile: string
}

interface GatewayConfig {
  publicOrigin: string
  internalOrigin?: string
  accounts: GatewayAccountConfig[]
  stateDirectory: string
  adminHomeDirectory: string
  clientDirectory: string
  host?: string
  port?: number
  providerControl?: GatewayProviderControl
  providerFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

interface CachedUpstreamSession {
  token: string
  expiresAt: number
}

interface GatewayTicket {
  tokenHash: string
  userId: string
  accountId: string | null
  origin: string
  expiresAt: number
  sessionExpiresAt: number
}

interface GatewaySocketData {
  sessionTokenHash: string
  userId: string
  accountId: string
  upstream: WebSocket | null
  queued: Array<string | Buffer | ArrayBuffer | Uint8Array>
  queuedBytes: number
  failed: boolean
  upstreamTicket?: string
  appUrl?: string
  expiresAt: number
  expiryTimer?: ReturnType<typeof setTimeout>
}

interface GatewaySocket extends ServerWebSocket<GatewaySocketData> {}

interface GatewayProviderControl {
  getStatuses(): Promise<AdminProviderAuthStatus[]>
  start(provider: ManagedProvider): Promise<unknown>
  submit(provider: ManagedProvider, code: string): Promise<void>
  cancel(provider: ManagedProvider): Promise<unknown>
  logout(provider: ManagedProvider): Promise<unknown>
  install(provider: ManagedProvider): Promise<unknown>
  getNativeToken?(provider: ManagedProvider, options: NativeProviderTokenRequest): Promise<NativeProviderTokenData>
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const WS_TICKET_TTL_MS = 30 * 1000
const MAX_WS_QUEUE_BYTES = 1024 * 1024
const MAX_PENDING_WS_BRIDGES = 32
const INTERNAL_PROVIDER_PATHS: Record<ManagedProvider, RegExp[]> = {
  codex: [/^\/v1\/responses$/],
  claude: [/^\/v1\/messages$/, /^\/v1\/messages\/count_tokens$/],
}

function bearerToken(request: Request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(request.headers.get("authorization") ?? "")
  return match?.[1] ?? null
}

function constantTimeTextEquals(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function isJsonRequest(request: Request) {
  return request.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true
}

async function readJson<T>(request: Request, maxBytes = 16 * 1024): Promise<T | null> {
  const length = Number(request.headers.get("content-length") ?? 0)
  if (length > maxBytes || !isJsonRequest(request)) return null
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks, size))
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } })
}

function safeAccountId(value: string) {
  return /^[a-z][a-z0-9_-]{0,31}$/.test(value)
}

function validateConfig(config: GatewayConfig) {
  const origin = new URL(config.publicOrigin)
  if (origin.protocol !== "http:" || origin.origin !== config.publicOrigin || origin.pathname !== "/") {
    throw new Error("Gateway public origin must be a plain HTTP origin")
  }
  if (config.internalOrigin) {
    const internal = new URL(config.internalOrigin)
    if (internal.protocol !== "http:" || internal.origin !== config.internalOrigin || internal.pathname !== "/") {
      throw new Error("Gateway internal origin must be a plain HTTP origin")
    }
  }
  const accounts = new Set<string>()
  for (const account of config.accounts) {
    if (!safeAccountId(account.id) || accounts.has(account.id)) throw new Error("Gateway account IDs must be unique valid names")
    accounts.add(account.id)
    const app = new URL(account.appUrl)
    if (app.protocol !== "http:" || app.username || app.password || app.search || app.hash || app.origin !== account.appUrl ||
      app.hostname !== `kanna_${account.id}` || app.port !== "3210" || app.pathname !== "/") {
      throw new Error("Gateway app URLs must be internal HTTP origins")
    }
    if (!path.isAbsolute(account.appPasswordFile) || !path.isAbsolute(account.accountTokenFile)) {
      throw new Error("Gateway account secret paths must be absolute")
    }
  }
}

function mapAccounts(config: GatewayConfig) {
  return new Map(config.accounts.map((account) => [account.id, account]))
}

function accountOriginHeaders(publicOrigin: string) {
  const headers = new Headers({
    Origin: publicOrigin,
    "X-Forwarded-Proto": "http",
    Host: new URL(publicOrigin).host,
  })
  return headers
}

function publicUserOrigin(request: Request, publicOrigin: string) {
  const origin = request.headers.get("origin")
  return new URL(request.url).origin === publicOrigin && (!origin || origin === publicOrigin)
}

function requestHasExpectedOrigin(request: Request, publicOrigin: string) {
  return request.headers.get("origin") === publicOrigin && new URL(request.url).origin === publicOrigin
}

function connectionProxyPath(provider: ManagedProvider, pathname: string) {
  return INTERNAL_PROVIDER_PATHS[provider].some((pattern) => pattern.test(pathname))
}

export function fixedUpstreamUrl(baseUrl: string, pathname: string, search = "") {
  const target = new URL(baseUrl)
  const expectedOrigin = target.origin
  target.pathname = pathname
  target.search = search
  if (target.origin !== expectedOrigin) throw new Error("Upstream URL origin changed")
  return target
}

function bytesOf(data: string | Buffer | ArrayBuffer | ArrayBufferView) {
  if (typeof data === "string") return Buffer.byteLength(data)
  if (data instanceof ArrayBuffer) return data.byteLength
  return data.byteLength
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return new TextDecoder().decode(Buffer.concat(chunks, size))
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

function upstreamWsUrl(appUrl: string) {
  const url = new URL(appUrl)
  url.protocol = "ws:"
  url.pathname = "/ws"
  url.search = ""
  url.hash = ""
  return url.href
}

export async function startGatewayServer(configInput?: GatewayConfig) {
  const configPath = process.env.KANNA_GATEWAY_CONFIG
  const resolvedConfig = configInput ?? (configPath
    ? JSON.parse(await readFile(configPath, "utf8")) as GatewayConfig
    : null)
  if (!resolvedConfig) throw new Error("KANNA_GATEWAY_CONFIG must point to generated gateway config")
  const config: GatewayConfig = resolvedConfig
  validateConfig(config)
  const store = new GatewayStore(config.stateDirectory)
  await store.listUsers()
  const accounts = mapAccounts(config)
  const publicOrigin = new URL(config.publicOrigin).origin
  const internalOrigin = new URL(config.internalOrigin ?? process.env.KANNA_GATEWAY_URL ?? "http://gateway:3210").origin
  const upstreamSessions = new Map<string, CachedUpstreamSession>()
  const upstreamSessionInflight = new Map<string, Promise<CachedUpstreamSession>>()
  const wsTickets = new Map<string, GatewayTicket>()
  const socketsBySession = new Map<string, Set<GatewaySocket>>()
  const activeProviderRequests = new Map<string, Set<AbortController>>()
  const activeProviderRequestOwners = new WeakMap<AbortController, string>()
  const providerSourceEpoch = new Map<ManagedProvider, number>([["codex", 0], ["claude", 0]])
  const providerSourceBlocked = new Set<ManagedProvider>()
  const providerSourceAwaitingLogin = new Set<ManagedProvider>()
  const loginAttempts = new Map<string, { count: number; resetAt: number }>()
  const pendingWsBySession = new Map<string, Set<AbortController>>()
  const pendingWsOwners = new WeakMap<AbortController, string>()
  let passwordChecksInFlight = 0
  const providerControl = config.providerControl ?? await (async () => {
    const { createAdminProviderControl } = await import("../gateway-provider-control")
    return createAdminProviderControl({ homeDir: config.adminHomeDirectory }) as GatewayProviderControl
  })()

  async function getUpstreamSession(accountId: string, force = false): Promise<CachedUpstreamSession> {
    const account = accounts.get(accountId)
    if (!account) throw new Error("Workspace account is not configured")
    const cached = upstreamSessions.get(accountId)
    if (!force && cached && cached.expiresAt > Date.now() + 60_000) return cached
    const active = upstreamSessionInflight.get(accountId)
    if (active) return active
    const pending = (async () => {
      const password = (await readFile(account.appPasswordFile, "utf8")).trim()
      if (!password) throw new Error("Workspace authentication unavailable")
      const response = await fetch(new URL("/auth/login", account.appUrl), {
        method: "POST",
        headers: { ...Object.fromEntries(accountOriginHeaders(publicOrigin)), "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ password, next: "/" }),
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error("Workspace authentication unavailable")
      const payload = await response.json() as { token?: unknown; expiresAt?: unknown }
      if (typeof payload.token !== "string" || typeof payload.expiresAt !== "number" || payload.expiresAt <= Date.now()) {
        throw new Error("Workspace authentication unavailable")
      }
      const session = { token: payload.token, expiresAt: payload.expiresAt }
      upstreamSessions.set(accountId, session)
      return session
    })()
    upstreamSessionInflight.set(accountId, pending)
    try {
      return await pending
    } finally {
      if (upstreamSessionInflight.get(accountId) === pending) upstreamSessionInflight.delete(accountId)
    }
  }

  async function refreshUpstreamSession(accountId: string, rejectedToken: string) {
    const current = upstreamSessions.get(accountId)
    if (current && current.token !== rejectedToken && current.expiresAt > Date.now()) return current
    if (current?.token === rejectedToken) upstreamSessions.delete(accountId)
    return getUpstreamSession(accountId, true)
  }

  async function authorize(request: Request) {
    if (!publicUserOrigin(request, publicOrigin)) return { error: jsonError("Forbidden", 403) } as const
    const token = bearerToken(request)
    if (!token) return { error: jsonError("Unauthorized", 401) } as const
    const resolved = await store.resolveSession(token)
    if (!resolved) return { error: jsonError("Unauthorized", 401) } as const
    return { ...resolved, token } as const
  }

  function isAdmin(role: GatewayRole) {
    return role === "admin"
  }

  function abortProviderRequests(connectionId?: string, userId?: string) {
    if (connectionId) {
      for (const controller of activeProviderRequests.get(connectionId) ?? []) controller.abort()
      activeProviderRequests.delete(connectionId)
      return
    }
    if (userId) {
      for (const [id, controllers] of activeProviderRequests) {
        for (const controller of controllers) {
          if (activeProviderRequestOwners.get(controller) === userId) {
            controller.abort()
            controllers.delete(controller)
          }
        }
        if (controllers.size === 0) activeProviderRequests.delete(id)
      }
    }
  }

  async function notifyManagedProviderRevoked(accountId: string, connectionId: string): Promise<boolean> {
    const account = accounts.get(accountId)
    if (!account) return false
    try {
      const token = (await readFile(account.accountTokenFile, "utf8")).trim()
      if (!token) return false
      const fetcher = config.providerFetch ?? fetch
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const response = await fetcher(new URL("/internal/managed-providers/revoke", account.appUrl), {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ connectionId }),
            signal: AbortSignal.timeout(4_000),
          })
          if (response.ok) return true
        } catch {}
      }
    } catch {}
    return false
  }

  async function revokeManagedProviderTargets(targets: Array<{ accountId: string; connectionId: string }>): Promise<boolean> {
    const unique = new Set(targets.map(({ accountId, connectionId }) => `${accountId}:${connectionId}`))
    let succeeded = true
    for (const value of unique) {
      const separator = value.indexOf(":")
      if (!await notifyManagedProviderRevoked(value.slice(0, separator), value.slice(separator + 1))) succeeded = false
    }
    return succeeded
  }

  function beginProviderAuthTransition(provider: ManagedProvider) {
    const epoch = (providerSourceEpoch.get(provider) ?? 0) + 1
    providerSourceEpoch.set(provider, epoch)
    providerSourceBlocked.add(provider)
    return epoch
  }

  async function finishProviderAuthTransition(provider: ManagedProvider, epoch: number) {
    if (providerSourceEpoch.get(provider) !== epoch) return
    providerSourceAwaitingLogin.delete(provider)
    try {
      const status = (await providerControl.getStatuses()).find((item) => item.id === provider)
      if (status?.authStatus === "signed_in" && providerSourceEpoch.get(provider) === epoch) providerSourceBlocked.delete(provider)
    } catch {}
  }

  async function revokeManagedProviderForUsers(userIds: string[], connectionIds: string[]): Promise<boolean> {
    const users = await store.listUsers()
    return revokeManagedProviderTargets(users.flatMap((user) =>
      userIds.includes(user.id) && user.accountId
        ? connectionIds.filter((id) => user.connectionIds.includes(id)).map((connectionId) => ({ accountId: user.accountId!, connectionId }))
        : [],
    ))
  }

  async function revokeNativeProvider(provider: ManagedProvider): Promise<boolean> {
    const connection = await store.getNativeConnection(provider)
    if (!connection) return true
    const users = (await store.listUsers()).filter((user) => user.enabled && user.accountId && user.connectionIds.includes(connection.id))
    return revokeManagedProviderTargets(users.map((user) => ({ accountId: user.accountId!, connectionId: connection.id })))
  }

  function closeSessionSockets(sessionKey: string) {
    for (const controller of pendingWsBySession.get(sessionKey) ?? []) controller.abort()
    pendingWsBySession.delete(sessionKey)
    const sockets = socketsBySession.get(sessionKey)
    if (!sockets) return
    for (const socket of sockets) socket.close(1008, "Session ended")
    socketsBySession.delete(sessionKey)
  }

  function abortUserPendingWebSockets(userId: string) {
    for (const [sessionHash, controllers] of pendingWsBySession) {
      for (const controller of controllers) {
        if (pendingWsOwners.get(controller) === userId) {
          controller.abort()
          controllers.delete(controller)
        }
      }
      if (controllers.size === 0) pendingWsBySession.delete(sessionHash)
    }
  }

  async function proxyAppRequest(request: Request, user: GatewayUserSummary, sessionHash: string) {
    if (!user.accountId) return jsonError("Workspace unavailable", 503)
    const account = accounts.get(user.accountId)
    if (!account) return jsonError("Workspace unavailable", 503)
    let upstreamSession: CachedUpstreamSession
    try {
      upstreamSession = await getUpstreamSession(user.accountId)
    } catch {
      return jsonError("Workspace unavailable", 503)
    }
    const currentSession = await store.resolveSessionHash(sessionHash)
    if (!currentSession || currentSession.user.id !== user.id) return jsonError("Unauthorized", 401)
    const incoming = new URL(request.url)
    let target: URL
    try {
      target = fixedUpstreamUrl(account.appUrl, incoming.pathname, incoming.search)
    } catch {
      return jsonError("Workspace unavailable", 503)
    }
    const headers = new Headers(request.headers)
    for (const name of [...headers.keys()]) {
      const lower = name.toLowerCase()
      if (["cookie", "host", "authorization", "proxy-authorization", "connection", "transfer-encoding", "sec-websocket-key", "sec-websocket-protocol", "sec-websocket-version"].includes(lower) ||
        lower.startsWith("proxy-") || lower.startsWith("x-kanna-") || lower.startsWith("x-forwarded-") || lower === "x-real-ip") headers.delete(name)
    }
    headers.set("Authorization", `Bearer ${upstreamSession.token}`)
    headers.set("Host", new URL(publicOrigin).host)
    headers.set("X-Forwarded-Proto", "http")
    headers.set("Origin", publicOrigin)
    let response: Response
    try {
      response = await fetch(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method.toUpperCase()) ? undefined : request.body,
        redirect: "manual",
        signal: request.signal,
      })
      if (response.status === 401) {
        try {
          await refreshUpstreamSession(user.accountId, upstreamSession.token)
        } catch {
          return jsonError("Workspace unavailable", 503)
        }
        if (!(["GET", "HEAD"].includes(request.method.toUpperCase()))) return jsonError("Workspace unavailable", 503)
        const refreshed = upstreamSessions.get(user.accountId)!
        headers.set("Authorization", `Bearer ${refreshed.token}`)
        response = await fetch(target, { method: request.method, headers, redirect: "manual", signal: request.signal })
      }
    } catch {
      return jsonError("Workspace unavailable", 503)
    }
    if (response.status >= 300 && response.status < 400) return jsonError("Workspace redirect blocked", 502)
    const outputHeaders = new Headers(response.headers)
    for (const name of ["set-cookie", "set-cookie2", "www-authenticate", "proxy-authenticate", "location"]) outputHeaders.delete(name)
    outputHeaders.set("Cache-Control", outputHeaders.get("cache-control") ?? "no-store")
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: outputHeaders })
  }

  async function handleInternal(request: Request, url: URL): Promise<Response | null> {
    const accessMatch = url.pathname === "/internal/provider-access"
    const providerMatch = url.pathname.match(/^\/internal\/providers\/([a-f0-9]{32})(\/.*)$/)
    if (!accessMatch && !providerMatch) return null
    const origin = request.headers.get("origin")
    if (url.origin !== internalOrigin || (origin !== null && origin !== internalOrigin)) return jsonError("Misdirected request", 421)
    const configuredAccount = await authenticateAccountToken(request)
    if (!configuredAccount) return jsonError("Unauthorized", 401)
    if (accessMatch) {
      const assigned = await store.getAssignedConnectionsForAccount(configuredAccount.id)
      const response: InternalGatewayProviderAccessResponse = {
        assigned: assigned.map(({ apiKey: _apiKey, ...summary }) => ({
          ...summary,
          ...(summary.kind === "api_key" ? { baseUrl: providerBaseUrl(summary.id, summary.provider) } : {}),
        })),
        selfFirst: true,
      }
      return Response.json(response, { headers: { "Cache-Control": "no-store" } })
    }
    const connectionId = providerMatch![1]!
    const suffix = providerMatch![2]!
    const assignments = await store.getAssignedConnectionsForAccount(configuredAccount.id)
    const connection = assignments.find((item) => item.id === connectionId)
    if (suffix === "/native-token") {
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
      if (!connection || connection.kind !== "native" || providerSourceBlocked.has(connection.provider)) return jsonError("Provider access is unavailable", 401)
      const authorization = await store.getNativeAuthorizationSnapshot(configuredAccount.id, connectionId)
      if (!authorization || authorization.provider !== connection.provider || providerSourceBlocked.has(connection.provider)) return jsonError("Provider access is unavailable", 401)
      const sourceEpoch = providerSourceEpoch.get(connection.provider) ?? 0
      if (!providerControl.getNativeToken) return jsonError("Native provider authentication is unavailable", 503)
      const body = await readJson<NativeProviderTokenRequest>(request)
      if (!body || (body.forceRefresh !== undefined && typeof body.forceRefresh !== "boolean") ||
        (body.previousAccountId !== undefined && (typeof body.previousAccountId !== "string" || body.previousAccountId.length > 256))) {
        return jsonError("Invalid request", 400)
      }
      if (providerSourceBlocked.has(connection.provider) || providerSourceEpoch.get(connection.provider) !== sourceEpoch) {
        return jsonError("Provider authentication changed", 401)
      }
      let token: NativeProviderTokenResponse
      try {
        token = { ...(await providerControl.getNativeToken(connection.provider, body)), connectionId }
      } catch (error) {
        if (error instanceof NativeProviderAccountChangedError) {
          return jsonError("Native provider account changed; restart the managed session", 409)
        }
        return jsonError("Native provider sign-in required", 401)
      }
      const current = await store.getNativeAuthorizationSnapshot(configuredAccount.id, connectionId)
      if (providerSourceBlocked.has(connection.provider) || providerSourceEpoch.get(connection.provider) !== sourceEpoch ||
        !current || current.userId !== authorization.userId || current.authVersion !== authorization.authVersion ||
        current.connectionId !== authorization.connectionId || current.provider !== authorization.provider) {
        return jsonError("Provider access changed", 401)
      }
      if (token.connectionId !== connection.id || token.provider !== connection.provider ||
        !token.accessToken || !Number.isSafeInteger(token.expiresAt) || token.expiresAt <= Date.now()) {
        return jsonError("Native provider authentication is unavailable", 503)
      }
      if (token.provider === "codex" && (!token.chatgptAccountId ||
        (body.previousAccountId && body.previousAccountId !== token.chatgptAccountId))) {
        return jsonError("Native provider account changed; restart the managed session", 409)
      }
      return Response.json(token, { headers: { "Cache-Control": "no-store" } })
    }
    if (!connection || !connectionProxyPath(connection.provider, suffix)) return jsonError("Not found", 404)
    const user = await store.getUserByAccount(configuredAccount.id)
    if (!user) return jsonError("Unauthorized", 401)
    if (connection.kind !== "api_key" || !connection.apiKey) return jsonError("Not found", 404)
    return proxyManagedProvider(request, user.id, configuredAccount.id, connectionId, connection.provider, connection.apiKey, suffix)
  }

  function providerBaseUrl(connectionId: string, provider: ManagedProvider) {
    const pathSuffix = provider === "codex" ? "/v1" : ""
    return `${process.env.KANNA_GATEWAY_URL ?? "http://gateway:3210"}/internal/providers/${connectionId}${pathSuffix}`
  }

  async function authenticateAccountToken(request: Request): Promise<GatewayAccountConfig | null> {
    const token = bearerToken(request)
    if (!token) return null
    for (const account of config.accounts) {
      try {
        const expected = (await readFile(account.accountTokenFile, "utf8")).trim()
        if (expected && constantTimeTextEquals(token, expected)) return account
      } catch {}
    }
    return null
  }

  async function proxyManagedProvider(
    request: Request,
    userId: string,
    accountId: string,
    connectionId: string,
    provider: ManagedProvider,
    apiKey: string,
    suffix: string,
  ) {
    const url = new URL(request.url)
    if (url.search || url.hash || request.method !== "POST" || !connectionProxyPath(provider, suffix)) return jsonError("Not found", 404)
    const controller = new AbortController()
    activeProviderRequestOwners.set(controller, userId)
    const controllers = activeProviderRequests.get(connectionId) ?? new Set<AbortController>()
    controllers.add(controller)
    activeProviderRequests.set(connectionId, controllers)
    const targetBase = provider === "codex" ? "https://api.openai.com" : "https://api.anthropic.com"
    let target: URL
    try {
      target = fixedUpstreamUrl(targetBase, suffix)
    } catch {
      return jsonError("Provider unavailable", 502)
    }
    const headers = new Headers()
    for (const name of ["content-type", "accept", "anthropic-version", "anthropic-beta", "openai-beta"]) {
      const value = request.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (provider === "codex") headers.set("Authorization", `Bearer ${apiKey}`)
    else {
      headers.set("x-api-key", apiKey)
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
    }
    const release = () => {
      controllers.delete(controller)
      if (controllers.size === 0 && activeProviderRequests.get(connectionId) === controllers) activeProviderRequests.delete(connectionId)
    }
    try {
      const currentUser = await store.getUserByAccount(accountId)
      const currentConnection = (await store.getAssignedConnectionsForAccount(accountId)).find((item) => item.id === connectionId)
      if (!currentUser || currentUser.id !== userId || !currentConnection || currentConnection.apiKey !== apiKey || currentConnection.provider !== provider) {
        release()
        return jsonError("Provider access unavailable", 403)
      }
      const response = await (config.providerFetch ?? fetch)(target, {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method.toUpperCase()) ? undefined : request.body,
        redirect: "manual",
        signal: AbortSignal.any([request.signal, controller.signal]),
      })
      const afterHeadersUser = await store.getUserByAccount(accountId)
      const afterHeadersConnection = (await store.getAssignedConnectionsForAccount(accountId)).find((item) => item.id === connectionId)
      if (!afterHeadersUser || afterHeadersUser.id !== userId || !afterHeadersConnection || afterHeadersConnection.apiKey !== apiKey || afterHeadersConnection.provider !== provider) {
        controller.abort()
        release()
        return jsonError("Provider access unavailable", 403)
      }
      if (response.status >= 300 && response.status < 400) {
        release()
        return jsonError("Provider redirect blocked", 502)
      }
      if (!response.ok) {
        const text = await readBoundedText(response, 64 * 1024)
        release()
        if (text === null) return jsonError("Provider request failed", response.status)
        const outputHeaders = new Headers()
        const contentType = response.headers.get("content-type")
        if (contentType?.startsWith("application/json")) outputHeaders.set("Content-Type", contentType)
        outputHeaders.set("Cache-Control", "no-store")
        const safeText = text.includes(apiKey) ? text.split(apiKey).join("[redacted]") : text
        return new Response(safeText, { status: response.status, headers: outputHeaders })
      }
      const outputHeaders = new Headers()
      for (const name of ["content-type", "retry-after"]) {
        const value = response.headers.get(name)
        if (value) outputHeaders.set(name, value)
      }
      outputHeaders.set("Cache-Control", "no-store")
      if (!response.body) {
        release()
        return new Response(null, { status: response.status, headers: outputHeaders })
      }
      const reader = response.body.getReader()
      const body = new ReadableStream<Uint8Array>({
        async pull(streamController) {
          try {
            const result = await reader.read()
            if (result.done) {
              release()
              streamController.close()
            } else {
              streamController.enqueue(result.value)
            }
          } catch (error) {
            release()
            streamController.error(error)
          }
        },
        async cancel(reason) {
          controller.abort(reason)
          try { await reader.cancel(reason) } finally { release() }
        },
      })
      return new Response(body, { status: response.status, headers: outputHeaders })
    } catch {
      release()
      return jsonError("Provider unavailable", 502)
    }
  }

  async function adminState(): Promise<AdminGatewayStateResponse> {
    const [users, connections, providerAuth] = await Promise.all([
      store.listUsers(),
      store.listConnections(),
      providerControl.getStatuses(),
    ])
    for (const auth of providerAuth) {
      if (providerSourceBlocked.has(auth.id) && providerSourceAwaitingLogin.has(auth.id) &&
        auth.authStatus === "signed_in" && auth.flow.phase === "idle") {
        providerSourceAwaitingLogin.delete(auth.id)
        providerSourceBlocked.delete(auth.id)
      }
    }
    const nativeByProvider = new Map(
      await Promise.all((["codex", "claude"] as const).map(async (provider) => [provider, await store.getNativeConnection(provider)] as const)),
    )
    return {
      users,
      connections,
      providerAuth: providerAuth.map((auth) => {
        const connection = nativeByProvider.get(auth.id)
        return {
          ...auth,
          ...(connection ? { connectionId: connection.id } : {}),
          shareable: Boolean(connection?.enabled && auth.authStatus === "signed_in"),
        }
      }),
    }
  }

  async function handleAdmin(request: Request, user: GatewayUserSummary, url: URL) {
    if (!isAdmin(user.role)) return jsonError("Forbidden", 403)
    if (url.pathname === "/api/admin/state" && request.method === "GET") {
      return Response.json(await adminState(), { headers: { "Cache-Control": "no-store" } })
    }
    const userPatch = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9]{32})$/)
    if (userPatch && request.method === "PATCH") {
      const body = await readJson<{ enabled?: unknown; password?: unknown }>(request)
      if (!body || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.password !== undefined && typeof body.password !== "string")) {
        return jsonError("Invalid request", 400)
      }
      if (body.password !== undefined && (body.password.length < 12 || body.password.length > 256)) return jsonError("Invalid request", 400)
      let withPassword: GatewayUserSummary | null
      try {
        const updated = body.enabled !== undefined
          ? await store.setUserEnabled(userPatch[1]!, body.enabled)
          : null
        withPassword = body.password !== undefined
          ? await store.setUserPassword(userPatch[1]!, body.password)
          : updated
      } catch {
        return jsonError("Invalid request", 400)
      }
      if (!withPassword) return jsonError("User not found", 404)
      if (body.enabled === false || body.password !== undefined) {
        abortProviderRequests(undefined, userPatch[1])
        abortUserPendingWebSockets(userPatch[1]!)
        for (const [sessionHash, sockets] of socketsBySession) {
          for (const socket of sockets) if (socket.data.userId === userPatch[1]) socket.close(1008, "User access changed")
          if ([...sockets].every((socket) => socket.data.userId === userPatch[1])) socketsBySession.delete(sessionHash)
        }
      }
      if (body.enabled === false || body.password !== undefined) {
        const nativeIds = (await store.listConnections()).filter((connection) => connection.kind === "native").map((connection) => connection.id)
        if (!await revokeManagedProviderForUsers([userPatch[1]!], nativeIds)) return jsonError("User access changed but managed workers could not be stopped", 503)
      }
      return Response.json(withPassword, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname === "/api/admin/connections" && request.method === "POST") {
      const body = await readJson<{ name?: unknown; provider?: unknown; kind?: unknown; apiKey?: unknown }>(request, 12 * 1024)
      if (!body || typeof body.name !== "string" || (body.provider !== "codex" && body.provider !== "claude") ||
        (body.kind !== undefined && body.kind !== "api_key" && body.kind !== "native")) return jsonError("Invalid request", 400)
      if (body.kind === "native") {
        if (body.apiKey !== undefined) return jsonError("Invalid request", 400)
        try {
          if (!providerControl.getNativeToken) return jsonError("Native provider sign-in required", 409)
          // Probe the official profile now so a CLI login performed after gateway
          // startup is detected without relying on the manager's cached snapshot.
          await providerControl.getNativeToken(body.provider, {})
          return Response.json(await store.createNativeConnection({ name: body.name, provider: body.provider }), { status: 201, headers: { "Cache-Control": "no-store" } })
        } catch {
          return jsonError("Native provider sign-in required", 409)
        }
      }
      if (typeof body.apiKey !== "string") return jsonError("Invalid request", 400)
      try {
        return Response.json(await store.createConnection({ name: body.name, provider: body.provider, apiKey: body.apiKey }), { status: 201, headers: { "Cache-Control": "no-store" } })
      } catch {
        return jsonError("Invalid managed connection", 400)
      }
    }
    const connection = url.pathname.match(/^\/api\/admin\/connections\/([a-f0-9]{32})$/)
    if (connection && request.method === "PATCH") {
      const body = await readJson<{ name?: unknown; enabled?: unknown; apiKey?: unknown }>(request, 12 * 1024)
      if (!body || (body.name !== undefined && typeof body.name !== "string") || (body.enabled !== undefined && typeof body.enabled !== "boolean") || (body.apiKey !== undefined && typeof body.apiKey !== "string")) return jsonError("Invalid request", 400)
      const prior = (await store.listConnections()).find((item) => item.id === connection[1])
      const revokeTargets = body.enabled === false && prior?.kind === "native"
        ? (await store.listUsers()).filter((item) => item.enabled && item.accountId && item.connectionIds.includes(prior.id)).map((item) => ({ accountId: item.accountId!, connectionId: prior.id }))
        : []
      try {
        const updated = await store.updateConnection(connection[1]!, body as { name?: string; enabled?: boolean; apiKey?: string })
        if (!updated) return jsonError("Connection not found", 404)
        abortProviderRequests(connection[1]!)
        if (revokeTargets.length && !await revokeManagedProviderTargets(revokeTargets)) return jsonError("Connection disabled but managed workers could not be stopped", 503)
        return Response.json(updated, { headers: { "Cache-Control": "no-store" } })
      } catch {
        return jsonError("Invalid managed connection", 400)
      }
    }
    if (connection && request.method === "DELETE") {
      const prior = (await store.listConnections()).find((item) => item.id === connection[1])
      const revokeTargets = prior?.kind === "native"
        ? (await store.listUsers()).filter((item) => item.enabled && item.accountId && item.connectionIds.includes(prior.id)).map((item) => ({ accountId: item.accountId!, connectionId: prior.id }))
        : []
      const removed = await store.deleteConnection(connection[1]!)
      if (!removed) return jsonError("Connection not found", 404)
      abortProviderRequests(connection[1]!)
      if (revokeTargets.length && !await revokeManagedProviderTargets(revokeTargets)) return jsonError("Connection deleted but managed workers could not be stopped", 503)
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
    }
    const grants = url.pathname.match(/^\/api\/admin\/users\/([a-f0-9]{32})\/grants$/)
    if (grants && request.method === "PUT") {
      const body = await readJson<{ connectionIds?: unknown }>(request)
      if (!body || !Array.isArray(body.connectionIds) || body.connectionIds.some((id) => typeof id !== "string")) return jsonError("Invalid request", 400)
      const requestedConnectionIds = body.connectionIds as string[]
      const priorUser = (await store.listUsers()).find((item) => item.id === grants[1])
      const nativeIds = new Set((await store.listConnections()).filter((item) => item.kind === "native").map((item) => item.id))
      const removedNativeIds = (priorUser?.connectionIds ?? []).filter((id) => nativeIds.has(id) && !requestedConnectionIds.includes(id))
      try {
        const updated = await store.setUserConnections(grants[1]!, requestedConnectionIds)
        if (!updated) return jsonError("User not found", 404)
        abortProviderRequests(undefined, grants[1])
        if (updated.accountId && removedNativeIds.length && !await revokeManagedProviderTargets(removedNativeIds.map((connectionId) => ({ accountId: updated.accountId!, connectionId })))) {
          return jsonError("Grant removed but managed workers could not be stopped", 503)
        }
        return Response.json(updated, { headers: { "Cache-Control": "no-store" } })
      } catch {
        return jsonError("Invalid grants", 400)
      }
    }
    const providerAuth = url.pathname.match(/^\/api\/admin\/provider-auth\/(codex|claude)\/(start|submit|cancel|logout|install)$/)
    if (providerAuth && request.method === "POST") {
      const provider = providerAuth[1] as ManagedProvider
      const operation = providerAuth[2]!
      let submittedCode: string | null = null
      if (operation === "submit") {
        const body = await readJson<{ code?: unknown }>(request)
        if (!body || typeof body.code !== "string") return jsonError("Invalid request", 400)
        submittedCode = body.code
      }
      const changesProviderAuth = ["start", "submit", "cancel", "logout"].includes(operation)
      const transitionEpoch = changesProviderAuth ? beginProviderAuthTransition(provider) : null
      try {
        if (changesProviderAuth && !await revokeNativeProvider(provider)) {
          return jsonError("Provider auth changed but managed workers could not be stopped", 503)
        }
        if (operation === "start") {
          const result = await providerControl.start(provider)
          if (transitionEpoch !== null && providerSourceEpoch.get(provider) === transitionEpoch) providerSourceAwaitingLogin.add(provider)
          return Response.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } })
        }
        if (operation === "submit") {
          await providerControl.submit(provider, submittedCode!)
          if (transitionEpoch !== null) await finishProviderAuthTransition(provider, transitionEpoch)
          return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
        }
        if (operation === "cancel") {
          const result = await providerControl.cancel(provider)
          if (transitionEpoch !== null) await finishProviderAuthTransition(provider, transitionEpoch)
          return Response.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } })
        }
        if (operation === "logout") {
          const result = await providerControl.logout(provider)
          if (transitionEpoch !== null && providerSourceEpoch.get(provider) === transitionEpoch) providerSourceAwaitingLogin.delete(provider)
          return Response.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } })
        }
        return Response.json((await providerControl.install(provider)) ?? { ok: true }, { headers: { "Cache-Control": "no-store" } })
      } catch {
        if (transitionEpoch !== null) await finishProviderAuthTransition(provider, transitionEpoch)
        return jsonError("Provider operation failed", 400)
      }
    }
    return jsonError("Not found", 404)
  }

  async function handleRequest(request: Request, server: Server<GatewaySocketData>) {
    const url = new URL(request.url)
    if (url.pathname === "/internal/provider-access" || url.pathname.startsWith("/internal/providers/")) {
      return (await handleInternal(request, url)) ?? jsonError("Not found", 404)
    }
    if (url.origin !== publicOrigin) return jsonError("Misdirected request", 421)
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { Allow: "GET, HEAD, POST, PATCH, PUT, DELETE, OPTIONS" } })
    if (url.pathname === "/auth/status") {
      const token = bearerToken(request)
      const resolved = token && publicUserOrigin(request, publicOrigin) ? await store.resolveSession(token) : null
      const payload: GatewayAuthStatusResponse = {
        authMode: "bearer",
        usernameRequired: true,
        enabled: true,
        authenticated: resolved !== null,
        user: resolved?.user ?? null,
        ...(resolved ? { expiresAt: resolved.session.expiresAt } : {}),
      }
      return Response.json(payload, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname === "/auth/login" && request.method === "POST") {
      if (!requestHasExpectedOrigin(request, publicOrigin)) return jsonError("Forbidden", 403)
      const body = await readJson<GatewayLoginRequest>(request)
      if (!body || typeof body.username !== "string" || body.username.length > 32 || typeof body.password !== "string" || body.password.length > 256) return jsonError("Invalid login", 400)
      const now = Date.now()
      for (const [entryKey, value] of loginAttempts) if (value.resetAt <= now) loginAttempts.delete(entryKey)
      if (loginAttempts.size > 10_000) return jsonError("Login temporarily unavailable", 429)
      const clientAddress = server.requestIP(request)?.address ?? "unknown"
      const key = `${clientAddress}:${body.username.toLowerCase()}`
      const attempt = loginAttempts.get(key)
      if (attempt && attempt.resetAt > now && attempt.count >= 10) return jsonError("Invalid username or password", 401)
      if (passwordChecksInFlight >= 4) return jsonError("Login temporarily unavailable", 429)
      passwordChecksInFlight += 1
      let verified: Awaited<ReturnType<GatewayStore["verifyPasswordWithVersion"]>>
      try {
        verified = await store.verifyPasswordWithVersion(body.username, body.password)
      } finally {
        passwordChecksInFlight -= 1
      }
      if (!verified) {
        const prior = loginAttempts.get(key)
        loginAttempts.set(key, prior && prior.resetAt > now ? { count: prior.count + 1, resetAt: prior.resetAt } : { count: 1, resetAt: now + 60_000 })
        return jsonError("Invalid username or password", 401)
      }
      const { user, authVersion } = verified
      if (user.accountId) {
        try {
          await getUpstreamSession(user.accountId)
        } catch {
          return jsonError("Workspace unavailable", 503)
        }
      }
      loginAttempts.delete(key)
      let session: Awaited<ReturnType<GatewayStore["createSession"]>>
      try {
        session = await store.createSession(user.id, SESSION_TTL_MS, now, authVersion)
      } catch {
        return jsonError("Invalid username or password", 401)
      }
      const payload: GatewayLoginResponse = { token: session.token, expiresAt: session.expiresAt, user }
      return Response.json(payload, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname === "/auth/logout" && request.method === "POST") {
      if (!requestHasExpectedOrigin(request, publicOrigin)) return jsonError("Forbidden", 403)
      const auth = await authorize(request)
      if ("error" in auth) return auth.error
      const resolved = await store.resolveSession(auth.token)
      await store.revokeSession(auth.token)
      if (resolved) closeSessionSockets(resolved.session.tokenHash)
      abortProviderRequests(undefined, auth.user.id)
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname === "/auth/ws-ticket" && request.method === "POST") {
      if (!requestHasExpectedOrigin(request, publicOrigin)) return jsonError("Forbidden", 403)
      const auth = await authorize(request)
      if ("error" in auth) return auth.error
      const now = Date.now()
      for (const [key, value] of wsTickets) if (value.expiresAt <= now) wsTickets.delete(key)
      if (wsTickets.size >= 4096) return jsonError("WebSocket service busy", 503)
      const ticket = randomBytes(32).toString("base64url")
      wsTickets.set(ticket, {
        tokenHash: auth.session.tokenHash,
        userId: auth.user.id,
        accountId: auth.user.accountId ?? null,
        origin: publicOrigin,
        expiresAt: Date.now() + WS_TICKET_TTL_MS,
        sessionExpiresAt: auth.session.expiresAt,
      })
      return Response.json({ ticket } satisfies { ticket: string }, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname.startsWith("/auth/")) return jsonError("Not found", 404)
    if (url.pathname.startsWith("/api/admin/")) {
      if (request.method !== "GET" && !requestHasExpectedOrigin(request, publicOrigin)) return jsonError("Forbidden", 403)
      const auth = await authorize(request)
      if ("error" in auth) return auth.error
      return handleAdmin(request, auth.user, url)
    }
    if (url.pathname === "/api/provider-access" && request.method === "GET") {
      const auth = await authorize(request)
      if ("error" in auth) return auth.error
      const assigned = await store.getAssignedConnections(auth.user.id)
      return Response.json({ assigned, selfFirst: true } satisfies GatewayProviderAccessResponse, { headers: { "Cache-Control": "no-store" } })
    }
    if (url.pathname === "/ws") {
      if (!requestHasExpectedOrigin(request, publicOrigin)) return jsonError("Forbidden", 403)
      const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((item) => item.trim())
      const hasVersion = protocols.includes("kanna.ws.v1")
      const ticketProtocol = protocols.find((item) => item.startsWith("kanna.ticket."))
      if (!hasVersion || !ticketProtocol) return jsonError("Unauthorized", 401)
      const ticket = ticketProtocol.slice("kanna.ticket.".length)
      const data = wsTickets.get(ticket)
      wsTickets.delete(ticket)
      if (!data || data.expiresAt <= Date.now() || data.sessionExpiresAt <= Date.now() || data.origin !== publicOrigin) return jsonError("Unauthorized", 401)
      const resolved = await store.resolveSessionHash(data.tokenHash)
      if (!resolved || resolved.user.id !== data.userId || !resolved.user.accountId || !data.accountId) return jsonError("Unauthorized", 401)
      const app = accounts.get(resolved.user.accountId)
      if (!app) return jsonError("Workspace unavailable", 503)
      let pendingCount = 0
      for (const controllers of pendingWsBySession.values()) pendingCount += controllers.size
      if (pendingCount >= MAX_PENDING_WS_BRIDGES) return jsonError("WebSocket service busy", 503)
      const pendingBridge = new AbortController()
      const pending = pendingWsBySession.get(data.tokenHash) ?? new Set<AbortController>()
      pending.add(pendingBridge)
      pendingWsBySession.set(data.tokenHash, pending)
      pendingWsOwners.set(pendingBridge, data.userId)
      let upstreamSession: CachedUpstreamSession
      try {
        upstreamSession = await getUpstreamSession(app.id)
      } catch {
        pending.delete(pendingBridge)
        if (pending.size === 0) pendingWsBySession.delete(data.tokenHash)
        return jsonError("Workspace unavailable", 503)
      }
      const sessionAfterLogin = await store.resolveSessionHash(data.tokenHash)
      if (pendingBridge.signal.aborted || data.sessionExpiresAt <= Date.now() || !sessionAfterLogin || sessionAfterLogin.user.id !== data.userId) {
        pending.delete(pendingBridge)
        if (pending.size === 0) pendingWsBySession.delete(data.tokenHash)
        return jsonError("Unauthorized", 401)
      }
      const upstreamTicketResponse = await fetch(new URL("/auth/ws-ticket", app.appUrl), {
        method: "POST",
        headers: {
          ...Object.fromEntries(accountOriginHeaders(publicOrigin)),
          Authorization: `Bearer ${upstreamSession.token}`,
          Accept: "application/json",
        },
        redirect: "manual",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), pendingBridge.signal]),
      }).catch(() => null)
      if (!upstreamTicketResponse?.ok) {
        pending.delete(pendingBridge)
        if (pending.size === 0) pendingWsBySession.delete(data.tokenHash)
        return jsonError("Workspace unavailable", 503)
      }
      const upstreamPayload = await upstreamTicketResponse.json() as { ticket?: unknown }
      pending.delete(pendingBridge)
      if (pending.size === 0) pendingWsBySession.delete(data.tokenHash)
      const latestSession = await store.resolveSessionHash(data.tokenHash)
      if (pendingBridge.signal.aborted || data.sessionExpiresAt <= Date.now() || !latestSession || latestSession.user.id !== data.userId || typeof upstreamPayload.ticket !== "string") return jsonError("Unauthorized", 401)
      const socketData: GatewaySocketData = {
        sessionTokenHash: data.tokenHash,
        userId: resolved.user.id,
        accountId: app.id,
        upstream: null,
        queued: [],
        queuedBytes: 0,
        failed: false,
        upstreamTicket: upstreamPayload.ticket,
        appUrl: app.appUrl,
        expiresAt: data.sessionExpiresAt,
      }
      const upgraded = server.upgrade(request, {
        headers: { "Sec-WebSocket-Protocol": "kanna.ws.v1" },
        data: socketData,
      })
      if (!upgraded) return jsonError("WebSocket upgrade failed", 400)
      return undefined
    }
    const auth = await authorize(request)
    if ("error" in auth) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/internal/")) return auth.error
      return serveGatewayStatic(config.clientDirectory, url.pathname)
    }
    if (auth.user.role === "admin") {
      if (url.pathname.startsWith("/api/")) return jsonError("Forbidden", 403)
      return serveGatewayStatic(config.clientDirectory, url.pathname)
    }
    return proxyAppRequest(request, auth.user, auth.session.tokenHash)
  }

  const server = Bun.serve<GatewaySocketData>({
    hostname: config.host ?? "0.0.0.0",
    port: config.port ?? 3210,
    idleTimeout: 255,
    async fetch(request, server) {
      try {
        return await handleRequest(request, server)
      } catch {
        return jsonError("Gateway request failed", 500)
      }
    },
      websocket: {
      backpressureLimit: MAX_WS_QUEUE_BYTES,
      closeOnBackpressureLimit: true,
      async open(socket) {
        const data = socket.data
        const remaining = data.expiresAt - Date.now()
        if (remaining <= 0) {
          socket.close(1008, "Ticket expired")
          return
        }
        data.expiryTimer = setTimeout(() => socket.close(1008, "Session expired"), remaining)
        const sockets = socketsBySession.get(data.sessionTokenHash) ?? new Set<GatewaySocket>()
        sockets.add(socket)
        socketsBySession.set(data.sessionTokenHash, sockets)
        if (!data.upstreamTicket || !data.appUrl) {
          data.failed = true
          socket.close(1011, "Workspace unavailable")
          return
        }
        const current = await store.resolveSessionHash(data.sessionTokenHash)
        if (!current || current.user.id !== data.userId || data.expiresAt <= Date.now() || socket.readyState !== WebSocket.OPEN) {
          socket.close(1008, "Session ended")
          return
        }
        const protocols = ["kanna.ws.v1", `kanna.ticket.${data.upstreamTicket}`]
        const upstream = new (WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket)(upstreamWsUrl(data.appUrl), {
          protocols,
          headers: { Origin: publicOrigin, Host: new URL(publicOrigin).host },
        })
        data.upstream = upstream
        upstream.binaryType = "arraybuffer"
        upstream.onopen = () => {
          for (const message of data.queued) {
            if (upstream.bufferedAmount > MAX_WS_QUEUE_BYTES) {
              data.failed = true
              socket.close(1013, "Gateway backpressure limit")
              upstream.close()
              return
            }
            upstream.send(message)
          }
          data.queued = []
          data.queuedBytes = 0
        }
        upstream.onmessage = (event) => {
          if (data.expiresAt <= Date.now()) {
            socket.close(1008, "Session expired")
            upstream.close()
            return
          }
          if (socket.readyState === WebSocket.OPEN) {
            if (socket.getBufferedAmount() > MAX_WS_QUEUE_BYTES) {
              socket.close(1013, "Gateway backpressure limit")
              upstream.close()
              return
            }
            socket.send(event.data as string | ArrayBuffer)
          }
        }
        upstream.onerror = () => {
          data.failed = true
          socket.close(1011, "Workspace unavailable")
        }
        upstream.onclose = (event) => {
          if (socket.readyState === WebSocket.OPEN) socket.close(event.code || 1000, event.reason.slice(0, 120))
        }
      },
      message(socket, message) {
        const data = socket.data
        if (data.expiresAt <= Date.now()) {
          socket.close(1008, "Session expired")
          data.upstream?.close()
          return
        }
        const upstream = data.upstream
        if (upstream?.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > MAX_WS_QUEUE_BYTES) {
            socket.close(1013, "Gateway backpressure limit")
            upstream.close()
            return
          }
          upstream.send(message)
          return
        }
        const length = bytesOf(message)
        data.queuedBytes += length
        if (data.queuedBytes > MAX_WS_QUEUE_BYTES) {
          data.failed = true
          socket.close(1009, "Gateway queue limit exceeded")
          upstream?.close()
          return
        }
        data.queued.push(message)
      },
      close(socket) {
        const data = socket.data
        if (data.expiryTimer) clearTimeout(data.expiryTimer)
        data.upstream?.close()
        const sockets = socketsBySession.get(data.sessionTokenHash)
        sockets?.delete(socket)
        if (sockets?.size === 0) socketsBySession.delete(data.sessionTokenHash)
      },
    },
  })
  console.log(`[gateway] listening on ${server.hostname}:${server.port}`)
  return { server, store }
}

async function serveGatewayStatic(root: string, pathname: string): Promise<Response> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return new Response("Bad request", { status: 400 })
  }
  if (decoded.includes("\\") || decoded.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
    return new Response("Not found", { status: 404 })
  }
  const candidate = path.resolve(root, `.${decoded === "/" ? "/index.html" : decoded}`)
  if (!candidate.startsWith(`${path.resolve(root)}${path.sep}`)) return new Response("Not found", { status: 404 })
  try {
    const info = await stat(candidate)
    if (!info.isFile()) return new Response("Not found", { status: 404 })
    const contentType = candidate.endsWith(".html") ? "text/html; charset=utf-8"
      : candidate.endsWith(".js") ? "text/javascript; charset=utf-8"
        : candidate.endsWith(".css") ? "text/css; charset=utf-8"
          : candidate.endsWith(".svg") ? "image/svg+xml"
            : candidate.endsWith(".json") ? "application/json"
              : candidate.endsWith(".png") ? "image/png"
                : candidate.endsWith(".woff2") ? "font/woff2"
                  : "application/octet-stream"
    return new Response(Bun.file(candidate), { headers: { "Content-Type": contentType, "Cache-Control": candidate.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" } })
  } catch {
    if (!path.extname(decoded)) return serveGatewayStatic(root, "/index.html")
    return new Response("Not found", { status: 404 })
  }
}
