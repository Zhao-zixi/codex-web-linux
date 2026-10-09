import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { clearBearerSession, ensureBearerServiceWorker, kannaFetch, setClientAuthMode, storeBearerSession } from "./auth-client"

let originalWindowDescriptor: PropertyDescriptor | undefined
let originalNavigatorDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
  originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator")
})

afterEach(() => {
  try {
    setClientAuthMode(null)
    clearBearerSession()
    mock.restore()
  } finally {
    if (originalWindowDescriptor) {
      Object.defineProperty(globalThis, "window", originalWindowDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
    if (originalNavigatorDescriptor) {
      Object.defineProperty(globalThis, "navigator", originalNavigatorDescriptor)
    } else {
      Reflect.deleteProperty(globalThis, "navigator")
    }
  }
})

test("same-origin bearer requests omit cookies and attach only the current origin token", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { location: { origin: "https://fnos.example.test:8444", href: "https://fnos.example.test:8444/" } } })
  setClientAuthMode("bearer")
  storeBearerSession("opaque-test-bearer-token-000000000000", Date.now() + 60_000)
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

  await kannaFetch("/api/projects", {
    credentials: "include",
    headers: { Cookie: "foreign=must-not-forward" },
  })

  const [, init] = fetchSpy.mock.calls[0]!
  const headers = new Headers(init?.headers)
  expect(init?.credentials).toBe("omit")
  expect(headers.get("authorization")).toBe("Bearer opaque-test-bearer-token-000000000000")
  expect(headers.has("cookie")).toBe(false)
})

test("external requests never receive the workspace bearer token", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: { location: { origin: "https://fnos.example.test:8444", href: "https://fnos.example.test:8444/" } } })
  setClientAuthMode("bearer")
  storeBearerSession("opaque-test-bearer-token-000000000000", Date.now() + 60_000)
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"))

  await kannaFetch("https://api.github.com/repos/example/project")

  const [, init] = fetchSpy.mock.calls[0]!
  expect(new Headers(init?.headers).has("authorization")).toBe(false)
})

test("claims an active auth worker when an existing page has no controller", async () => {
  const origin = "https://fnos.example.test:8444"
  let controller: ServiceWorker | null = null
  let claimRequests = 0
  const serviceWorker = new EventTarget() as ServiceWorkerContainer
  Object.defineProperty(serviceWorker, "controller", { get: () => controller })
  const activeWorker = {
    scriptURL: `${origin}/kanna-auth-sw.js`,
    state: "activated",
    postMessage(message: { type?: string; requestId?: string }, ports: MessagePort[]) {
      claimRequests += 1
      queueMicrotask(() => {
        controller = activeWorker as unknown as ServiceWorker
        serviceWorker.dispatchEvent(new Event("controllerchange"))
        ports[0]!.postMessage({ type: "kanna.auth.claimed", requestId: message.requestId, claimed: true })
      })
    },
  } as unknown as ServiceWorker
  const registration = {
    scope: `${origin}/`,
    active: activeWorker,
  } as ServiceWorkerRegistration
  Object.defineProperty(serviceWorker, "register", { value: async () => registration })
  Object.defineProperty(serviceWorker, "ready", { value: Promise.resolve(registration) })
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { origin }, setTimeout, clearTimeout },
  })
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { serviceWorker } })

  await ensureBearerServiceWorker()

  expect(claimRequests).toBe(1)
  expect(serviceWorker.controller).toBe(activeWorker)
})
