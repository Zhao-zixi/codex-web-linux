import { app, dialog, shell, type BrowserWindow } from "electron"
import { autoUpdater } from "electron-updater"
import { quitNow } from "./quit"

/**
 * Updates to this app, the window. Kanna itself is the global npm install and
 * updates itself, in Settings, the way it does in a terminal.
 *
 * build.sh publishes each release to kanna.sh/downloads/mac (kanna-site
 * src/worker/mac-releases.ts): latest-mac.yml names the newest version and
 * its zip, which electron-updater downloads in the background and Squirrel
 * installs when the app quits. Only a packaged app has a signature Squirrel
 * can check the update against, so `bun run start` never updates.
 */
const FEED = "https://kanna.sh/downloads/mac"
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

let offered: string | null = null
let getWindow: () => BrowserWindow | null = () => null

export function startUpdates(window: () => BrowserWindow | null) {
  getWindow = window
  if (!app.isPackaged) return
  autoUpdater.setFeedURL({ provider: "generic", url: FEED })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on("update-downloaded", (info) => void offerRestart(info.version))
  autoUpdater.on("error", (error) => console.error("[kanna] update check failed", error))
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  void check()
  setInterval(check, CHECK_EVERY_MS)
}

/** Kanna › Check for Updates…: the same check, with an answer either way. */
export async function checkForUpdatesNow() {
  const window = getWindow()
  const show = (message: string, detail?: string) =>
    window ? dialog.showMessageBox(window, { message, detail }) : dialog.showMessageBox({ message, detail })
  if (!app.isPackaged) {
    await show("Updates are off in this build", "A development build has no update feed. Kanna itself still updates from npm, in Settings.")
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const version = result?.updateInfo.version
    if (!result?.isUpdateAvailable || !version) {
      await show("Kanna is up to date", `Kanna for Mac ${app.getVersion()} is the newest version.`)
    } else if (offered !== version) {
      // The download goes on after this dialog closes. When it failed (every
      // time on 2.0.x, which lacked app-update.yml), nothing said so, and
      // this dialog claimed a download that never came.
      result.downloadPromise?.catch((error) => void offerManualDownload(version, error))
      await show(`Kanna for Mac ${version} is downloading`, "Kanna offers to restart once it's ready, or installs it the next time you quit.")
    }
  } catch (error) {
    await show("Couldn't check for updates", String(error))
  }
}

/** The update didn't download: the DMG from kanna.sh installs it by hand. */
async function offerManualDownload(version: string, error: unknown) {
  const window = getWindow()
  const options = {
    message: `Couldn't download Kanna for Mac ${version}`,
    detail: `Download it from kanna.sh and drag it into Applications.\n\n${String(error)}`,
    buttons: ["Download", "Cancel"],
    defaultId: 0,
    cancelId: 1,
  }
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  if (response === 0) void shell.openExternal(`${FEED}/Kanna.dmg`)
}

/** Once per version: restart now, or let it install on the next quit. */
async function offerRestart(version: string) {
  if (offered === version) return
  offered = version
  const window = getWindow()
  const options = {
    message: `Kanna for Mac ${version} is ready`,
    detail: "Restart to use it now, or it installs the next time you quit. Running chats pick up where they left off.",
    buttons: ["Restart Now", "Later"],
    defaultId: 0,
    cancelId: 1,
  }
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)
  // The server keeps running through it: only the window is updating.
  if (response === 0) void quitNow("keepOnline", () => autoUpdater.quitAndInstall())
}
