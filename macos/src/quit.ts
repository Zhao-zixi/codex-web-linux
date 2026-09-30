import { app, dialog, powerMonitor, type BrowserWindow, type MessageBoxOptions } from "electron"
import { keepAwake } from "./mac-setup"
import { readPrefs, writePrefs } from "./prefs"
import { agent, type QuitPlan } from "./server-agent"

/**
 * What quitting does to the server. A terminal's `kanna` is the terminal's:
 * the app just goes. One the app started would stop with it, taking this
 * Mac off Kanna Cloud and stopping its running chats, so the app asks first:
 * keep it running in the background, or stop it. A server kept running is
 * found again the next time the app opens, and quitting asks again.
 *
 * Closing the window is quitting too (main.ts), so both go through here.
 */

export type QuitChoice = "keepOnline" | "goOffline"

let quitting = false
let deciding = false

export function isQuitting() {
  return quitting
}

export function installQuitHandler(getWindow: () => BrowserWindow | null) {
  // Logging out or shutting down: never hold that up with a question. The
  // app's server stops by itself once the app is gone (src/server/mac-app.ts),
  // and macOS stops a kept one.
  powerMonitor.on("shutdown", () => {
    quitting = true
  })

  app.on("before-quit", (event) => {
    if (quitting) return
    event.preventDefault()
    if (deciding) return
    deciding = true
    void decide(getWindow(), null)
      .then((quit) => {
        if (!quit) return
        quitting = true
        app.quit()
      })
      .finally(() => {
        deciding = false
      })
  })
}

/**
 * Quit with a choice made in advance, without asking: an app update keeps
 * the server running (it's the window that's updating), the uninstaller
 * stops it. `quit` is how to go, once the server is dealt with.
 */
export async function quitNow(choice: QuitChoice, quit: () => void = () => app.quit()) {
  if (quitting || deciding) return
  deciding = true
  try {
    await decide(null, choice)
  } finally {
    deciding = false
  }
  quitting = true
  quit()
}

/** False to stay open (Cancel). */
async function decide(window: BrowserWindow | null, preset: QuitChoice | null) {
  const plan = await agent.quitPlan()
  if (plan.kind === "leave") return true
  if (plan.kind === "stop") {
    await new Promise<void>((resolve) => agent.stop(resolve))
    return true
  }
  const choice = preset ?? readPrefs().quitBehavior ?? (await ask(window, plan))
  if (!choice) return false
  if (choice === "keepOnline" && (await agent.keepRunning())) {
    keepAwake.handOff(plan.pid)
  } else {
    await agent.goOffline(plan.pid)
  }
  return true
}

async function ask(window: BrowserWindow | null, plan: Extract<QuitPlan, { kind: "ask" }>): Promise<QuitChoice | null> {
  const chats = plan.runningChats === 1 ? "1 chat is running" : `${plan.runningChats} chats are running`
  const stops = plan.runningChats > 0
    ? `${chats}. Stopping pauses ${plan.runningChats === 1 ? "it" : "them"} until Kanna starts again.`
    : "Stopping it takes Kanna offline until you open the app again."
  const options: MessageBoxOptions = {
    type: "question",
    message: plan.cloud ? "Keep this Mac online?" : "Keep Kanna running?",
    detail: plan.cloud
      ? `Kanna can keep running after the app quits, so your other devices still reach this Mac. ${stops}`
      : `Kanna can keep running in the background after the app quits. ${stops}`,
    buttons: plan.cloud ? ["Keep Online", "Go Offline", "Cancel"] : ["Keep Running", "Stop Kanna", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: "Don't ask again",
  }
  const { response, checkboxChecked } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options)
  if (response === 2) return null
  const choice: QuitChoice = response === 0 ? "keepOnline" : "goOffline"
  // Settings › This Mac changes it back.
  if (checkboxChecked) writePrefs({ quitBehavior: choice })
  return choice
}
