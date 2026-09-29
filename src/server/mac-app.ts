/**
 * The Kanna Mac app (macos/) and the CLI keep each other running. The app is
 * a window around the globally installed `kanna`: opening it starts
 * `kanna --no-open` (or adopts one a terminal already started), and running
 * `kanna` in a terminal opens the app instead of a browser tab. This file is
 * the CLI's half of that arrangement.
 */

import process from "node:process"
import { spawn } from "node:child_process"

export const MAC_APP_BUNDLE_ID = "sh.kanna.mac"
/** Registered by the app (macos/electron-builder.yml). `open?url=` names the server to show. */
export const MAC_APP_URL_SCHEME = "kanna-app"

/** The app sets this so a server it started does not outlive a crashed app. */
export const EXIT_WITH_PARENT_ENV_VAR = "KANNA_EXIT_WITH_PARENT"

export function macAppOpenUrl(localUrl: string) {
  return `${MAC_APP_URL_SCHEME}://open?url=${encodeURIComponent(localUrl)}`
}

/**
 * Show `localUrl` in the Mac app when it is installed. Resolves false when it
 * is not (or off macOS), so the caller falls back to the browser. `open -b`
 * exits non-zero when no app has the bundle id, which is the whole check.
 */
export function openInMacApp(localUrl: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== "darwin") return Promise.resolve(false)
  return new Promise((resolve) => {
    let child
    try {
      child = spawn("open", ["-b", MAC_APP_BUNDLE_ID, macAppOpenUrl(localUrl)], { stdio: "ignore" })
    } catch {
      resolve(false)
      return
    }
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
}

/**
 * A server the app started should go when the app goes, crash included. A
 * crashed parent does not signal its children; they get reparented to launchd
 * (pid 1), so poll for that. The supervisor and its child both watch: the
 * supervisor for the app, the child for a supervisor that was killed outright.
 */
export function exitWithParent(onOrphaned: () => void, env: Record<string, string | undefined> = process.env) {
  if (env[EXIT_WITH_PARENT_ENV_VAR] !== "1") return
  setInterval(() => {
    if (process.ppid === 1) onOrphaned()
  }, 2_000).unref()
}
