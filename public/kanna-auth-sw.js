const API_PREFIX = "/api/"
const RESPONSE_TIMEOUT_MS = 800

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("message", (event) => {
  const data = event.data
  const port = event.ports[0]
  const source = event.source
  if (data?.type !== "kanna.auth.claim" || typeof data.requestId !== "string" || !/^[0-9a-f-]{36}$/i.test(data.requestId) || !port) return
  event.waitUntil((async () => {
    let claimed = false
    if (source && source.type === "window" && new URL(source.url).origin === self.location.origin && new URL(source.url).pathname.startsWith(new URL(self.registration.scope).pathname)) {
      await self.clients.claim()
      claimed = true
    }
    port.postMessage({ type: "kanna.auth.claimed", requestId: data.requestId, claimed })
    port.close()
  })())
})

function isProtectedApiRequest(request) {
  const url = new URL(request.url)
  return url.origin === self.location.origin && url.pathname.startsWith(API_PREFIX)
}

async function requestToken(clientId) {
  const candidates = []
  if (clientId) {
    const client = await self.clients.get(clientId)
    if (client && client.type === "window" && new URL(client.url).origin === self.location.origin) candidates.push(client)
  }
  if (candidates.length === 0) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    candidates.push(...windows.filter((client) => new URL(client.url).origin === self.location.origin))
  }

  if (candidates.length === 0) {
    return null
  }
  return new Promise((resolve) => {
    let remaining = candidates.length
    let settled = false
    const timeout = setTimeout(() => {
      settled = true
      resolve(null)
    }, RESPONSE_TIMEOUT_MS)
    for (const client of candidates) {
      const requestId = crypto.randomUUID()
      const channel = new MessageChannel()
      channel.port1.onmessage = (event) => {
        channel.port1.close()
        if (settled) return
        const value = event.data
        if (value && value.requestId === requestId && typeof value.token === "string" && value.token.length > 0) {
          settled = true
          clearTimeout(timeout)
          resolve(value.token)
          return
        }
        remaining -= 1
        if (remaining === 0) {
          settled = true
          clearTimeout(timeout)
          resolve(null)
        }
      }
      client.postMessage({ type: "kanna.auth.request", requestId }, [channel.port2])
    }
  })
}

self.addEventListener("fetch", (event) => {
  if (!isProtectedApiRequest(event.request)) return
  event.respondWith((async () => {
    const headers = new Headers(event.request.headers)
    let token = headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1]
    headers.delete("Cookie")
    if (!token) token = await requestToken(event.clientId)
    if (!token) {
      return new Response("Unauthorized", { status: 401 })
    }
    headers.set("Authorization", `Bearer ${token}`)
    const request = new Request(event.request, { headers, credentials: "omit", mode: "same-origin" })
    return fetch(request)
  })())
})
