export type ClientAuthMode = "cookie" | "bearer" | null

const TOKEN_KEY = "kanna.auth.token"
const EXPIRY_KEY = "kanna.auth.expiresAt"
let authMode: ClientAuthMode = null
let memoryToken: string | null = null
let memoryTokenExpiresAt = 0
let authWorkerRegistration: ServiceWorkerRegistration | null = null
let authWorkerMessageListenerInstalled = false

export function setClientAuthMode(mode: ClientAuthMode) {
  authMode = mode
  if (mode !== "bearer") {
    memoryToken = null
    memoryTokenExpiresAt = 0
    try {
      sessionStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(EXPIRY_KEY)
    } catch {}
  } else {
    memoryToken = readStoredBearerToken()
  }
}

export async function ensureBearerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support secure workspace sessions")
  if (!authWorkerMessageListenerInstalled) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      const registration = authWorkerRegistration
      const source = event.source
      const data = event.data as { type?: unknown; requestId?: unknown } | null
      if (!registration || !(source instanceof ServiceWorker) || source !== registration.active) return
      const requestId = data?.requestId
      const port = event.ports[0]
      if (!port || typeof requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(requestId) || data?.type !== "kanna.auth.request") return
      port.postMessage({ requestId, token: getBearerToken() })
      port.close()
    })
    authWorkerMessageListenerInstalled = true
  }
  await navigator.serviceWorker.register("/kanna-auth-sw.js", { scope: "/" })
  let activationTimeout = 0
  let registration: ServiceWorkerRegistration
  try {
    registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => { activationTimeout = window.setTimeout(() => reject(new Error("Secure workspace session worker did not activate")), 10_000) }),
    ])
  } finally {
    window.clearTimeout(activationTimeout)
  }
  authWorkerRegistration = registration
  const expectedScope = new URL("/", window.location.origin).href
  const expectedScript = new URL("/kanna-auth-sw.js", window.location.origin).href
  if (registration.scope !== expectedScope || !registration.active || registration.active.scriptURL !== expectedScript) {
    throw new Error("Secure workspace session worker registration is invalid")
  }
  if (navigator.serviceWorker.controller === registration.active) return
  await requestWorkerClaim(registration.active)
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener("controllerchange", onChange)
      reject(new Error("Secure workspace session worker did not take control"))
    }, 10_000)
    const onChange = () => {
      if (navigator.serviceWorker.controller !== registration.active) return
      window.clearTimeout(timeout)
      navigator.serviceWorker.removeEventListener("controllerchange", onChange)
      resolve()
    }
    navigator.serviceWorker.addEventListener("controllerchange", onChange)
    if (navigator.serviceWorker.controller) onChange()
  })
}

function requestWorkerClaim(worker: ServiceWorker) {
  return new Promise<void>((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const channel = new MessageChannel()
    const timeout = window.setTimeout(() => {
      channel.port1.close()
      reject(new Error("Secure workspace session worker did not claim this page"))
    }, 10_000)
    channel.port1.onmessage = (event: MessageEvent<{ type?: unknown; requestId?: unknown; claimed?: unknown }>) => {
      window.clearTimeout(timeout)
      channel.port1.close()
      if (event.data?.type !== "kanna.auth.claimed" || event.data.requestId !== requestId || event.data.claimed !== true) {
        reject(new Error("Secure workspace session worker refused to claim this page"))
        return
      }
      resolve()
    }
    worker.postMessage({ type: "kanna.auth.claim", requestId }, [channel.port2])
  })
}

export function storeBearerSession(token: string, expiresAt: number) {
  memoryToken = token
  memoryTokenExpiresAt = expiresAt
  try {
    sessionStorage.setItem(TOKEN_KEY, token)
    sessionStorage.setItem(EXPIRY_KEY, String(expiresAt))
  } catch {}
}

export function clearBearerSession() {
  memoryToken = null
  memoryTokenExpiresAt = 0
  try {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(EXPIRY_KEY)
  } catch {}
}

function readStoredBearerToken() {
  try {
    const token = sessionStorage.getItem(TOKEN_KEY)
    const expiry = Number(sessionStorage.getItem(EXPIRY_KEY))
    if (token && Number.isFinite(expiry) && expiry > Date.now()) {
      memoryTokenExpiresAt = expiry
      return token
    }
    memoryToken = null
    memoryTokenExpiresAt = 0
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem(EXPIRY_KEY)
    return null
  } catch {
    return null
  }
}

export function getBearerToken() {
  if (memoryToken && memoryTokenExpiresAt <= Date.now()) clearBearerSession()
  if (!memoryToken) memoryToken = readStoredBearerToken()
  return memoryToken
}

export function kannaFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const requestUrl = new URL(input instanceof Request ? input.url : String(input), window.location.href)
  if (requestUrl.origin !== window.location.origin) return fetch(input, init)

  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const isBearer = authMode === "bearer"
  const token = isBearer ? getBearerToken() : null
  if (isBearer) {
    headers.delete("Cookie")
    if (token) headers.set("Authorization", `Bearer ${token}`)
  }
  return fetch(input, { ...init, headers, credentials: isBearer ? "omit" : init.credentials ?? "same-origin" })
}

export function isBearerAuthMode() {
  return authMode === "bearer"
}

export function getClientAuthMode() {
  return authMode
}

export async function requestWebSocketTicket() {
  const token = getBearerToken()
  if (!token) throw new Error("Authentication required")
  const response = await kannaFetch("/auth/ws-ticket", {
    method: "POST",
    headers: { Accept: "application/json" },
  })
  if (!response.ok) throw new Error("WebSocket authorization failed")
  return (await response.json() as { ticket: string }).ticket
}
