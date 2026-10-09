import { randomBytes, timingSafeEqual } from "node:crypto"

const SESSION_COOKIE_NAME = "kanna_session"

export interface AuthStatusPayload {
  enabled: boolean
  authenticated: boolean
  authMode?: "cookie" | "bearer"
}

export interface AuthManager {
  readonly mode: "cookie" | "bearer"
  isAuthenticated(req: Request): boolean
  validateOrigin(req: Request): boolean
  redirectToApp(req: Request): Response
  handleLogin(req: Request, nextPath: string): Promise<Response>
  handleLogout(req: Request): Response
  handleStatus(req: Request): Response
  handleWebSocketTicket(req: Request): Response
  consumeWebSocketTicket(req: Request): string | null
  getSessionId(req: Request): string | null
  isSessionActive(sessionId: string, origin: string): boolean
}

function parseCookies(header: string | null) {
  const cookies = new Map<string, string>()
  if (!header) return cookies

  for (const segment of header.split(";")) {
    const trimmed = segment.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf("=")
    if (separator <= 0) continue
    const key = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    cookies.set(key, decodeURIComponent(value))
  }

  return cookies
}

function sanitizeNextPath(nextPath: string | null | undefined) {
  if (!nextPath || typeof nextPath !== "string") return "/"
  if (!nextPath.startsWith("/")) return "/"
  if (nextPath.startsWith("//")) return "/"
  if (nextPath.startsWith("/auth/login")) return "/"
  return nextPath
}

function forwardedProto(req: Request): "http" | "https" | null {
  const xfp = req.headers.get("x-forwarded-proto")
  if (!xfp) return null
  const value = xfp.split(",")[0]?.trim().toLowerCase()
  return value === "http" || value === "https" ? value : null
}

function effectiveOrigin(req: Request, trustProxy: boolean): string {
  const url = new URL(req.url)
  if (!trustProxy) return url.origin
  const proto = forwardedProto(req)
  const scheme = proto ?? url.protocol.replace(":", "")
  return `${scheme}://${url.host}`
}

function shouldUseSecureCookie(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const proto = forwardedProto(req)
    if (proto) return proto === "https"
  }
  return new URL(req.url).protocol === "https:"
}

function buildCookie(name: string, value: string, req: Request, trustProxy: boolean, extras: string[] = []) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ]

  if (shouldUseSecureCookie(req, trustProxy)) {
    parts.push("Secure")
  }

  parts.push(...extras)
  return parts.join("; ")
}

async function readLoginForm(req: Request) {
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = await req.json() as { password?: unknown; next?: unknown }
    return {
      password: typeof payload.password === "string" ? payload.password : "",
      nextPath: sanitizeNextPath(typeof payload.next === "string" ? payload.next : "/"),
    }
  }

  const formData = await req.formData()
  return {
    password: String(formData.get("password") ?? ""),
    nextPath: sanitizeNextPath(String(formData.get("next") ?? "/")),
  }
}

export interface AuthManagerOptions {
  /**
   * When true, the auth layer trusts X-Forwarded-Proto to decide whether the
   * public origin is http or https. The hostname always comes from the Host
   * header (never X-Forwarded-Host) because X-Forwarded-Host is passed
   * through by some tunnels unmodified and would otherwise allow open
   * redirects.
   * Enable only when the server is reachable solely through a trusted reverse
   * proxy such as cloudflared.
   */
  trustProxy?: boolean
  mode?: "cookie" | "bearer"
  expectedOrigin?: string
  sessionTtlMs?: number
  webSocketTicketTtlMs?: number
}

const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** Protect hosted browser requests from same-site sibling-subdomain CSRF. */
export function shouldRejectHostedCrossOrigin(
  req: Request,
  hostedMode: boolean,
  validateOrigin: (request: Request) => boolean
) {
  if (!hostedMode || !req.headers.has("origin")) return false
  const { pathname } = new URL(req.url)
  const protectedRequest = pathname === "/ws" || (pathname.startsWith("/api/") && STATE_CHANGING_METHODS.has(req.method.toUpperCase()))
  return protectedRequest && !validateOrigin(req)
}

export function createAuthManager(password: string, options: AuthManagerOptions = {}): AuthManager {
  const sessions = new Set<string>()
  const bearerSessions = new Map<string, { id: string; origin: string; expiresAt: number }>()
  const sessionsById = new Map<string, { origin: string; expiresAt: number }>()
  const webSocketTickets = new Map<string, { origin: string; sessionId: string; expiresAt: number }>()
  const expectedPassword = Buffer.from(password)
  const trustProxy = options.trustProxy ?? false
  const mode = options.mode ?? "cookie"
  const expectedOrigin = options.expectedOrigin
  const sessionTtlMs = options.sessionTtlMs ?? 12 * 60 * 60 * 1000
  const webSocketTicketTtlMs = options.webSocketTicketTtlMs ?? 30 * 1000

  function getSessionToken(req: Request) {
    return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE_NAME) ?? null
  }

  function isAuthenticated(req: Request) {
    if (mode === "bearer") {
      const token = getBearerToken(req)
      if (!token || !validateOrigin(req)) return false
      const session = bearerSessions.get(token)
      if (!session) return false
      if (session.expiresAt <= Date.now()) {
        bearerSessions.delete(token)
        sessionsById.delete(session.id)
        return false
      }
      if (session.origin !== effectiveOrigin(req, trustProxy)) return false
      if (req.headers.has("origin") && req.headers.get("origin") !== session.origin) return false
      return true
    }
    const sessionToken = getSessionToken(req)
    return Boolean(sessionToken && sessions.has(sessionToken))
  }

  function validateOrigin(req: Request) {
    const origin = req.headers.get("origin")
    const requestOrigin = effectiveOrigin(req, trustProxy)
    if (mode === "bearer" && expectedOrigin && requestOrigin !== expectedOrigin) return false
    if (!origin) return true
    return origin === requestOrigin
  }

  function createSessionCookie(req: Request) {
    const sessionToken = randomBytes(32).toString("base64url")
    sessions.add(sessionToken)
    return buildCookie(SESSION_COOKIE_NAME, sessionToken, req, trustProxy)
  }

  function getBearerToken(req: Request) {
    const authorization = req.headers.get("authorization")
    const match = authorization ? /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization) : null
    return match?.[1] ?? null
  }

  function createBearerSession(req: Request) {
    const token = randomBytes(32).toString("base64url")
    const id = randomBytes(16).toString("base64url")
    const expiresAt = Date.now() + sessionTtlMs
    const session = { id, origin: effectiveOrigin(req, trustProxy), expiresAt }
    bearerSessions.set(token, session)
    sessionsById.set(id, session)
    return { token, expiresAt }
  }

  function clearSessionCookie(req: Request) {
    const sessionToken = getSessionToken(req)
    if (sessionToken) {
      sessions.delete(sessionToken)
    }
    return buildCookie(SESSION_COOKIE_NAME, "", req, trustProxy, ["Max-Age=0"])
  }

  function verifyPassword(candidate: string) {
    const actual = Buffer.from(candidate)
    if (actual.length !== expectedPassword.length) {
      return false
    }
    return timingSafeEqual(actual, expectedPassword)
  }

  function handleStatus(req: Request) {
    return Response.json({
      enabled: true,
      authenticated: isAuthenticated(req),
      authMode: mode,
    } satisfies AuthStatusPayload)
  }

  function redirectToApp(req: Request) {
    const currentUrl = new URL(req.url)
    return Response.redirect(new URL(sanitizeNextPath(currentUrl.searchParams.get("next")), effectiveOrigin(req, trustProxy)), 302)
  }

  async function handleLogin(req: Request, fallbackNextPath: string) {
    if (!validateOrigin(req) || (mode === "bearer" && !req.headers.has("origin"))) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    const { password: candidate, nextPath } = await readLoginForm(req)
    if (!verifyPassword(candidate)) {
      return Response.json({ error: "Invalid password" }, { status: 401 })
    }

    if (mode === "bearer") {
      const session = createBearerSession(req)
      return Response.json({
        ok: true,
        token: session.token,
        expiresAt: session.expiresAt,
        nextPath: sanitizeNextPath(nextPath || fallbackNextPath),
      })
    }
    const response = Response.json({ ok: true, nextPath: sanitizeNextPath(nextPath || fallbackNextPath) })
    response.headers.set("Set-Cookie", createSessionCookie(req))
    return response
  }

  function handleLogout(req: Request) {
    if (!validateOrigin(req) || (mode === "bearer" && !req.headers.has("origin"))) {
      return Response.json({ error: "Forbidden" }, { status: 403 })
    }

    if (mode === "bearer") {
      const token = getBearerToken(req)
      if (token) {
        const session = bearerSessions.get(token)
        bearerSessions.delete(token)
        if (session) {
          sessionsById.delete(session.id)
          for (const [ticket, record] of webSocketTickets) {
            if (record.sessionId === session.id) webSocketTickets.delete(ticket)
          }
        }
      }
      return Response.json({ ok: true })
    }
    const response = Response.json({ ok: true })
    response.headers.set("Set-Cookie", clearSessionCookie(req))
    return response
  }

  function handleWebSocketTicket(req: Request) {
    if (mode !== "bearer" || !req.headers.has("origin") || !validateOrigin(req) || !isAuthenticated(req)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }
    const sessionToken = getBearerToken(req)!
    const session = bearerSessions.get(sessionToken)!
    const expiresAt = Date.now() + webSocketTicketTtlMs
    const ticket = randomBytes(32).toString("base64url")
    webSocketTickets.set(ticket, { origin: effectiveOrigin(req, trustProxy), sessionId: session.id, expiresAt })
    return Response.json({ ticket, expiresAt }, { headers: { "Cache-Control": "no-store" } })
  }

  function consumeWebSocketTicket(req: Request) {
    if (mode !== "bearer" || !req.headers.has("origin") || !validateOrigin(req)) return null
    const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((value) => value.trim())
    if (!protocols.includes("kanna.ws.v1")) return null
    const ticketProtocol = protocols.find((value) => value.startsWith("kanna.ticket."))
    if (!ticketProtocol) return null
    const ticket = ticketProtocol.slice("kanna.ticket.".length)
    const record = webSocketTickets.get(ticket)
    // A validly shaped ticket is one-use even when the origin or session has
    // expired by the time the upgrade reaches the server.
    webSocketTickets.delete(ticket)
    if (!record || record.expiresAt <= Date.now() || record.origin !== effectiveOrigin(req, trustProxy)) return null
    if (!isSessionActive(record.sessionId, record.origin)) return null
    return record.sessionId
  }

  function getSessionId(req: Request) {
    if (mode !== "bearer" || !isAuthenticated(req)) return null
    return bearerSessions.get(getBearerToken(req)!)?.id ?? null
  }

  function isSessionActive(sessionId: string, origin: string) {
    if (mode !== "bearer") return false
    const session = sessionsById.get(sessionId)
    if (!session) return false
    if (session.expiresAt <= Date.now()) {
      sessionsById.delete(sessionId)
      for (const [token, record] of bearerSessions) {
        if (record.id === sessionId) bearerSessions.delete(token)
      }
      for (const [ticket, record] of webSocketTickets) {
        if (record.sessionId === sessionId) webSocketTickets.delete(ticket)
      }
      return false
    }
    return session.origin === origin
  }

  return {
    mode,
    isAuthenticated,
    validateOrigin,
    redirectToApp,
    handleLogin,
    handleLogout,
    handleStatus,
    handleWebSocketTicket,
    consumeWebSocketTicket,
    getSessionId,
    isSessionActive,
  }
}
