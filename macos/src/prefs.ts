import { app } from "electron"
import fs from "node:fs"
import path from "node:path"

/**
 * The app's own settings, as one JSON file in its userData folder
 * (~/Library/Application Support/Kanna).
 */
export interface Prefs {
  serverMode?: "installed" | "development" | "custom"
  customServerURL?: string
  devCheckout?: string
  pageZoom?: number
  keepAwakeOnPower?: boolean
  keepAwakeOnBattery?: boolean
  /** AppAuth's P-256 private key, hex. Kept across a relaunch. */
  appAuthKey?: string
  windowBounds?: { x: number; y: number; width: number; height: number }
  /** What quitting does to a server the app started, when the user ticked
   *  "Don't ask again" (quit.ts). Unset: ask. */
  quitBehavior?: "keepOnline" | "goOffline"
  /** The `caffeinate` a kept-running server was handed (mac-setup.ts). */
  caffeinatePid?: number
}

let cached: Prefs | null = null

function file() {
  return path.join(app.getPath("userData"), "prefs.json")
}

export function readPrefs(): Prefs {
  if (cached) return cached
  try {
    cached = JSON.parse(fs.readFileSync(file(), "utf8")) as Prefs
  } catch {
    cached = {}
  }
  return cached
}

export function writePrefs(change: Partial<Prefs>) {
  const next: Prefs = { ...readPrefs(), ...change }
  for (const key of Object.keys(change) as (keyof Prefs)[]) {
    if (change[key] === undefined) delete next[key]
  }
  cached = next
  fs.mkdirSync(path.dirname(file()), { recursive: true })
  fs.writeFileSync(file(), JSON.stringify(next, null, 2))
}
