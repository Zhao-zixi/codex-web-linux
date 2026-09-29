import { create } from "zustand"

/**
 * The Kanna for Mac window (macos/). The app talks to the page through the
 * `kanna` WebKit message handler one way and `window.__kanna*` functions the
 * other (macos/Kanna/WebBridge.swift, MainWindowController.swift).
 *
 * The app and this page ship separately (Sparkle vs npm), so the page checks
 * `window.__kannaMacApp.features` before it shows anything that needs the
 * app, and an app older than the feature simply doesn't get it.
 */

interface MacAppHandler {
  postMessage: (message: unknown) => void
}

export type MacAppFeature = "fleet" | "setup"

/** The live state behind the setup wizard's This Mac step (macos/Kanna/MacSetup.swift). */
export interface MacSetupState {
  loginItem: "enabled" | "requiresApproval" | "off"
  keepAwakeOnPower: boolean
  keepAwakeOnBattery: boolean
  pluggedIn: boolean
  lidClosingSleeps: boolean | null
  fileVault: boolean | null
  fullDiskAccess: boolean
}

declare global {
  interface Window {
    __kannaMacApp?: { version?: string; features?: string[] }
    __kannaMacSetup?: MacSetupState
    __kannaOpenSetup?: (step?: string) => void
  }
}

function handler(): MacAppHandler | null {
  if (typeof window === "undefined") return null
  const webkit = (window as { webkit?: { messageHandlers?: { kanna?: MacAppHandler } } }).webkit
  return webkit?.messageHandlers?.kanna ?? null
}

export function isMacApp() {
  return handler() !== null
}

export function macAppHasFeature(feature: MacAppFeature) {
  return isMacApp() && (window.__kannaMacApp?.features ?? []).includes(feature)
}

/**
 * This Mac's own server, not another machine's page opened through the
 * Fleet: the only page that may change this Mac's settings. The app checks
 * the same thing on its side.
 */
export function isOnThisMac() {
  if (typeof window === "undefined") return false
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname)
}

/** The Mac settings (wizard step, Settings › This Mac) apply here and only here. */
export function macSetupAvailable() {
  return macAppHasFeature("setup") && isOnThisMac()
}

export function postToMacApp(message: { type: string } & Record<string, unknown>) {
  handler()?.postMessage(message)
}

export const useMacSetupStore = create<{ state: MacSetupState | null }>()(() => ({
  state: typeof window !== "undefined" ? window.__kannaMacSetup ?? null : null,
}))

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("kanna:mac-setup", (event) => {
    useMacSetupStore.setState({ state: (event as CustomEvent<MacSetupState>).detail })
  })
}

/** Each one answers with the new state. */
export const macSetup = {
  refresh: () => postToMacApp({ type: "macSetup.refresh" }),
  setLoginItem: (enabled: boolean) => postToMacApp({ type: "macSetup.setLoginItem", enabled }),
  openLoginItems: () => postToMacApp({ type: "macSetup.openLoginItems" }),
  setKeepAwake: (change: { onPower?: boolean; onBattery?: boolean }) =>
    postToMacApp({ type: "macSetup.setKeepAwake", ...change }),
  openFullDiskAccess: () => postToMacApp({ type: "macSetup.openFullDiskAccess" }),
  startAppDrag: () => postToMacApp({ type: "macSetup.startAppDrag" }),
}
