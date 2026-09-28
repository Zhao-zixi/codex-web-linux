/**
 * The Kanna for Mac window (macos/). The app talks to the page through the
 * `kanna` WebKit message handler one way and `window.__kanna*` functions the
 * other (macos/Kanna/WebBridge.swift, MainWindowController.swift).
 */

interface MacAppHandler {
  postMessage: (message: unknown) => void
}

function handler(): MacAppHandler | null {
  if (typeof window === "undefined") return null
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: MacAppHandler } } }).webkit
  return webkit?.messageHandlers?.kanna ?? null
}

export function isMacApp() {
  return handler() !== null
}

export function postToMacApp(message: { type: string } & Record<string, unknown>) {
  handler()?.postMessage(message)
}
