import type { ClientEnvelope, ServerEnvelope } from "../shared/protocol"
import type { AppThemePreference } from "../shared/types"
import { DEMO_UNAVAILABLE_MESSAGE, DemoBackend } from "./backend"

/**
 * Puts the browser in a state where the real Kanna client runs with no
 * server. Imported for its side effects before anything from the client, so
 * every module sees the fakes from its very first line: zustand's `persist`
 * reads storage while its module evaluates, and the socket reads
 * `WebSocket` when it connects.
 */

// Enough delay that the client sees a round trip, not a synchronous reply,
// so ordering matches the real socket (ack before the snapshot it causes).
const LATENCY_MS = 8

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length() {
    return this.values.size
  }

  clear() {
    this.values.clear()
  }

  getItem(key: string) {
    return this.values.get(key) ?? null
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null
  }

  removeItem(key: string) {
    this.values.delete(key)
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value))
  }
}

// Every visit starts from the same demo. Real storage would carry one visit's
// sidebar layout and drafts into the next, and would mix the app's keys into
// kanna.sh's own storage.
function installMemoryStorage() {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true })
    } catch {
      // The real storage stays; the demo still works, it just remembers.
    }
  }
  try {
    // The transcript cache skips itself when IndexedDB is missing.
    Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true })
  } catch {
    // Same as above.
  }
}

export function readThemeParam(): AppThemePreference {
  const theme = new URLSearchParams(window.location.search).get("theme")
  return theme === "light" || theme === "system" ? theme : "dark"
}

let backend: DemoBackend | null = null
let openSocket: DemoWebSocket | null = null

function getBackend() {
  if (!backend) {
    backend = new DemoBackend((envelope: ServerEnvelope) => {
      const socket = openSocket
      if (!socket) return
      const data = JSON.stringify(envelope)
      window.setTimeout(() => socket.deliver(data), LATENCY_MS)
    }, undefined, { theme: readThemeParam() })
    backend.start()
  }
  return backend
}

class DemoWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState: number = DemoWebSocket.CONNECTING
  readonly url: string
  readonly protocol = ""
  readonly extensions = ""
  binaryType: BinaryType = "blob"
  bufferedAmount = 0
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    window.setTimeout(() => {
      if (this.readyState !== DemoWebSocket.CONNECTING) return
      this.readyState = DemoWebSocket.OPEN
      openSocket = this
      getBackend()
      this.fire(new Event("open"))
    }, LATENCY_MS)
  }

  send(data: string) {
    if (this.readyState !== DemoWebSocket.OPEN) return
    const envelope = JSON.parse(data) as ClientEnvelope
    window.setTimeout(() => getBackend().receive(envelope), LATENCY_MS)
  }

  close() {
    if (this.readyState === DemoWebSocket.CLOSED) return
    this.readyState = DemoWebSocket.CLOSED
    if (openSocket === this) openSocket = null
    // The next socket resubscribes under the same ids, so the backend keeps
    // its subscriptions; pushes meanwhile go nowhere, as they would on a
    // real dropped connection.
    this.fire(new CloseEvent("close", { code: 1000, wasClean: true }))
  }

  deliver(data: string) {
    if (this.readyState !== DemoWebSocket.OPEN) return
    this.fire(new MessageEvent("message", { data }))
  }

  private fire(event: Event) {
    this.dispatchEvent(event)
    const handler = event.type === "open" ? this.onopen
      : event.type === "message" ? this.onmessage
        : event.type === "close" ? this.onclose
          : this.onerror
    ;(handler as ((event: Event) => void) | null)?.(event)
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

// The demo is served from kanna.sh, so its same-origin /api and /auth calls
// would otherwise reach the site's own worker. Answer them here instead, and
// skip GitHub lookups for the made-up repos.
function installFetchShim() {
  const realFetch = window.fetch.bind(window)
  const demoFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const url = new URL(href, window.location.href)
    if (url.origin === window.location.origin) {
      if (url.pathname === "/auth/status") return jsonResponse({ enabled: false, authenticated: true })
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/") || url.pathname === "/health") {
        return jsonResponse({ error: DEMO_UNAVAILABLE_MESSAGE }, 404)
      }
    }
    if (url.hostname === "api.github.com") return jsonResponse({ message: "Not Found" }, 404)
    return realFetch(input, init)
  }
  window.fetch = demoFetch as typeof window.fetch
}

// Inside an iframe, focus() and scrollIntoView() scroll the parent page to
// the frame, and a focused composer would take the space bar from a visitor
// who is only scrolling the homepage. The app focuses the composer on load,
// so both wait for the visitor to touch the demo first.
function installEmbedGuards() {
  if (window.top === window) return
  let interacted = false
  const markInteracted = () => {
    interacted = true
  }
  for (const type of ["pointerdown", "keydown", "touchstart"]) {
    window.addEventListener(type, markInteracted, { capture: true, once: true })
  }
  const focus = HTMLElement.prototype.focus
  HTMLElement.prototype.focus = function guardedFocus(this: HTMLElement, options?: FocusOptions) {
    if (!interacted) return
    focus.call(this, options)
  }
  const scrollIntoView = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function guardedScrollIntoView(this: Element, arg?: boolean | ScrollIntoViewOptions) {
    if (!interacted) return
    scrollIntoView.call(this, arg)
  }
}

installMemoryStorage()
installFetchShim()
installEmbedGuards()
Object.defineProperty(window, "WebSocket", { value: DemoWebSocket, configurable: true, writable: true })
