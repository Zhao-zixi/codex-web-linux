import { app } from "electron"
import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readPrefs, writePrefs } from "./prefs"

/**
 * Which Kanna the window shows. Every build can switch (the Server menu),
 * because plenty of people run a fork, a checkout or a second server, and
 * the window should show whichever one they point it at.
 *
 * - Installed: the global `kanna` (bun install -g kanna-code) on port 3210,
 *   with its data in ~/.kanna. The default.
 * - Development: a checkout's `bun run dev`: Vite on 5174 with hot reload,
 *   in front of a server on 5175 that keeps its data in ~/.kanna-dev, so
 *   trying things never touches real chats. `bun run start` in macos/
 *   defaults to this.
 * - Custom: any Kanna server by address. The app only connects.
 */
export type ServerMode =
  | { kind: "installed" }
  | { kind: "development" }
  | { kind: "custom"; url: string }

export function currentMode(): ServerMode {
  const prefs = readPrefs()
  switch (prefs.serverMode) {
    case "installed":
      return { kind: "installed" }
    case "development":
      return { kind: "development" }
    case "custom":
      return prefs.customServerURL ? { kind: "custom", url: prefs.customServerURL } : { kind: "installed" }
    default:
      return stampedCheckout() ? { kind: "development" } : { kind: "installed" }
  }
}

export function saveMode(mode: ServerMode) {
  if (mode.kind === "custom") writePrefs({ serverMode: "custom", customServerURL: mode.url })
  else writePrefs({ serverMode: mode.kind })
}

export function sameMode(a: ServerMode, b: ServerMode) {
  return a.kind === b.kind && (a.kind !== "custom" || a.url === (b as { url: string }).url)
}

/** The last custom address, to prefill Server › Custom URL…. */
export function lastCustomURL() {
  return readPrefs().customServerURL ?? null
}

/** Where the page loads from: the server itself, or Vite in front of it. */
export function pageURL(mode: ServerMode) {
  switch (mode.kind) {
    case "installed":
      return "http://localhost:3210"
    case "development":
      return "http://localhost:5174"
    case "custom":
      return mode.url
  }
}

/** ~/.kanna or ~/.kanna-dev; a custom server's data lives wherever its owner put it. */
export function dataRoot(mode: ServerMode) {
  if (mode.kind === "installed") return path.join(os.homedir(), ".kanna")
  if (mode.kind === "development") return path.join(os.homedir(), ".kanna-dev")
  return null
}

/** Mirrors instanceFingerprint() in src/server/instance.ts. */
export function fingerprint(mode: ServerMode) {
  const root = dataRoot(mode)
  if (!root) return null
  return createHash("sha256").update(path.join(root, "data")).digest("hex").slice(0, 16)
}

/**
 * The checkout Development mode runs. Unpackaged (`bun run start`) it is the
 * checkout this app is running from; Server › Choose Checkout… picks any
 * other, fork or not.
 */
function stampedCheckout() {
  return app.isPackaged ? null : path.resolve(app.getAppPath(), "..")
}

export function devCheckout() {
  const candidate = readPrefs().devCheckout ?? stampedCheckout()
  return candidate && isCheckout(candidate) ? candidate : null
}

export function setDevCheckout(dir: string) {
  writePrefs({ devCheckout: path.resolve(dir) })
}

export function isCheckout(dir: string) {
  return fs.existsSync(path.join(dir, "scripts", "dev.ts"))
}
