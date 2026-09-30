import "./user-data"
import {
  app,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  session,
  shell,
  systemPreferences,
  type MenuItemConstructorOptions,
} from "electron"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handleAuthCallback, URL_SCHEME } from "./app-auth"
import { fleet } from "./fleet"
import { handleMacSetup, keepAwake } from "./mac-setup"
import { dragWindow } from "./native-window"
import { showSheet } from "./panels"
import { installQuitHandler, isQuitting } from "./quit"
import { agent, isLoopback } from "./server-agent"
import { devCheckout, isCheckout, lastCustomURL, setDevCheckout, type ServerMode } from "./server-mode"
import { shellEnv } from "./shell-env"
import { confirmAndUninstall } from "./uninstall"
import { checkForUpdatesNow, startUpdates } from "./updates"
import { MainWindow } from "./window"

/**
 * Kanna for Mac: a window around the globally installed `kanna` (bun install
 * -g kanna-code), which it starts, or installs when it's missing. It carries
 * no server of its own, so it releases only when macos/ changes; Kanna itself
 * keeps updating from npm. A terminal's `kanna` opens this app instead of a
 * browser tab (src/server/mac-app.ts, by bundle id sh.kanna.mac).
 */

let main: MainWindow | null = null
const pendingURLs: string[] = []

if (!app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on("second-instance", () => main?.bringToFront())
}

// <scheme>://auth from the browser's sign-in (app-auth.ts), and
// <scheme>://open?url=… naming a local server to show.
app.on("open-url", (event, url) => {
  event.preventDefault()
  if (main) handleURL(url)
  else pendingURLs.push(url)
})

if (app.isPackaged) app.setAsDefaultProtocolClient(URL_SCHEME)

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: app.getName(), applicationVersion: app.getVersion(), copyright: "MIT License" })
  installSessionPolicy()

  main = new MainWindow()
  main.onChange = rebuildMenu
  // Closing the window is quitting, which may ask about the server first
  // (quit.ts): the window stays until that's answered, and stays on Cancel.
  main.win.on("close", (event) => {
    if (isQuitting()) return
    event.preventDefault()
    app.quit()
  })
  main.win.on("closed", () => {
    main = null
    app.quit()
  })
  rebuildMenu()

  keepAwake.start()
  // A heavy shell profile takes seconds to read; start now, alongside the
  // check for a server that is already running.
  void shellEnv()

  agent.onChange = (state) => {
    main?.showState(state)
    rebuildMenu()
    // This Mac's pairing (and so which machine it is) belongs to the server
    // that runs.
    if (state.kind === "running") void fleet.refresh()
  }
  main.showState(agent.state)
  agent.start()

  fleet.onChange = () => {
    main?.pushFleet()
    rebuildMenu()
  }
  fleet.start()

  void main.show()
  for (const url of pendingURLs.splice(0)) handleURL(url)
  startUpdates(() => main?.win ?? null)
})

app.on("did-become-active", () => void fleet.refresh())

installQuitHandler(() => main?.win ?? null)

// Page messages

/** The page's `kanna` message handler (preload.ts). */
ipcMain.on("kanna:initial", (event) => {
  event.returnValue = {
    chrome: main?.initialChrome() ?? { fullScreen: false, vars: {} },
    version: app.getVersion(),
    features: ["fleet", "setup"],
  }
})

ipcMain.on("kanna:message", (event, body: Record<string, unknown>) => {
  if (!main || event.sender !== main.win.webContents || typeof body?.type !== "string") return
  const type = body.type
  if (type === "openMachine") {
    main.bringToFront()
    void main.showMachine(typeof body.subdomain === "string" ? body.subdomain : null)
  } else if (type.startsWith("macSetup.")) {
    // Only the local server's page may change this Mac's settings: another
    // machine's page, opened through the Fleet, gets the same handler.
    const frame = event.senderFrame
    if (!frame || frame.parent || !isLoopback(new URL(frame.url).hostname)) return
    void handleMacSetup(type, body).then((state) => main?.pushMacSetup(state))
  }
})

// The page's title bar (preload.ts): a press drags the window; a
// double-click does what System Settings › Desktop & Dock says
// ("Double-click a window's title bar to").
ipcMain.on("kanna:window-drag", (event) => {
  if (main && event.sender === main.win.webContents) dragWindow(main.win.getNativeWindowHandle())
})

ipcMain.on("kanna:window-double-click", (event) => {
  if (!main || event.sender !== main.win.webContents) return
  const win = main.win
  switch (systemPreferences.getUserDefault("AppleActionOnDoubleClick", "string")) {
    case "Minimize":
      win.minimize()
      break
    case "None":
      break
    default:
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
  }
})

function handleURL(raw: string) {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return
  }
  if (url.protocol !== `${URL_SCHEME}:` || !main) return
  if (url.hostname === "auth") {
    void handleAuthCallback(url, fleet.site)
  } else if (url.hostname === "open") {
    const target = url.searchParams.get("url")
    if (target) {
      main.showThisMac()
      agent.start(target)
    }
  }
  main.bringToFront()
}

// Session

function installSessionPolicy() {
  const defaultSession = session.defaultSession
  const trusted = (url: string | undefined) => {
    try {
      return !!main && !!url && main.isServerHost(new URL(url).hostname)
    } catch {
      return false
    }
  }

  defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const allowed = trusted(details.requestingUrl)
    if (permission === "media") {
      // Dictation. macOS still asks the user once for the app.
      const types = "mediaTypes" in details ? details.mediaTypes ?? [] : []
      if (!allowed || !types.length || types.some((type) => type !== "audio")) return callback(false)
      void systemPreferences.askForMediaAccess("microphone").then(callback, () => callback(false))
      return
    }
    callback(allowed && ["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications", "pointerLock"].includes(permission))
  })
  // Chromium's own notifications carry the chat notifications
  // (src/client/lib/chatBrowserNotifications.ts), so the page's origin needs
  // the permission.
  defaultSession.setPermissionCheckHandler((_contents, permission, origin) =>
    trusted(origin) && ["clipboard-read", "clipboard-sanitized-write", "fullscreen", "notifications", "media"].includes(permission)
  )

  // Downloads (CSV exports, share exports, attachments) go straight to
  // ~/Downloads under a name that's free, as a browser's do.
  defaultSession.on("will-download", (_event, item) => {
    const destination = unusedPath(app.getPath("downloads"), item.getFilename())
    item.setSavePath(destination)
    item.once("done", (_done, state) => {
      // Bounces the Downloads stack in the Dock, as a browser download does.
      if (state === "completed") app.dock?.downloadFinished(destination)
    })
  })
}

function unusedPath(dir: string, filename: string) {
  const ext = path.extname(filename)
  const name = path.basename(filename, ext)
  let candidate = path.join(dir, filename)
  for (let index = 2; fs.existsSync(candidate); index++) candidate = path.join(dir, `${name} ${index}${ext}`)
  return candidate
}

// Menu actions

function switchServer(mode: ServerMode) {
  main?.showThisMac()
  agent.switchMode(mode)
  rebuildMenu()
}

async function chooseCheckout() {
  if (!main) return
  const result = await dialog.showOpenDialog(main.win, {
    properties: ["openDirectory"],
    message: "Choose a Kanna checkout. Development mode runs its `bun run dev`.",
    defaultPath: devCheckout() ?? undefined,
  })
  const dir = result.filePaths[0]
  if (result.canceled || !dir) return
  if (!isCheckout(dir)) {
    await dialog.showMessageBox(main.win, { message: "That folder isn't a Kanna checkout", detail: "A checkout has scripts/dev.ts in it." })
    return
  }
  setDevCheckout(dir)
  if (agent.mode.kind === "development") agent.restart()
  else switchServer({ kind: "development" })
  rebuildMenu()
}

/** Any Kanna server by address: a fork on its own port or data dir, a server
 *  on another Mac. The app connects and never starts it. */
async function useCustomServer() {
  if (!main) return
  const typed = await showSheet<string>(main.win, "customServer", { last: lastCustomURL() })
  if (typed === null) return
  let text = typed.trim()
  if (!text.includes("://")) text = `http://${text}`
  let url: URL | null = null
  try {
    url = new URL(text)
  } catch {}
  if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname) {
    await dialog.showMessageBox(main.win, {
      message: "That isn't a server address",
      detail: "Use http:// or https://, a host and, usually, a port.",
    })
    return
  }
  // The window loads the server's root; a pasted chat link still works.
  switchServer({ kind: "custom", url: url.origin })
}

// Menu

/** Rebuilt whenever something it shows changes: Electron has no
 *  menuNeedsUpdate, and machines come and go online. */
function rebuildMenu() {
  if (!main) return
  const window = main
  const mode = agent.mode
  const checkout = devCheckout()

  const fleetItems: MenuItemConstructorOptions[] = []
  if (!fleet.thisSubdomain) {
    // Putting this Mac online is the setup wizard's Kanna Cloud step, the
    // same claim link the CLI shows.
    fleetItems.push(
      { label: "Put This Mac Online…", click: () => (window.bringToFront(), window.openSetup("cloud")) },
      { label: "Manage Fleet…", click: () => void shell.openExternal(new URL("/fleet", fleet.site).toString()) }
    )
  } else {
    const thisMac = fleet.list.find((machine) => machine.subdomain === fleet.thisSubdomain)
    const others = fleet.list.filter((machine) => machine.subdomain !== fleet.thisSubdomain)
    fleetItems.push({
      label: `${thisMac?.name ?? "This Mac"} (This machine)`,
      type: "checkbox",
      checked: !window.remoteMachine,
      icon: statusDot(true),
      click: () => (window.bringToFront(), void window.showMachine(null)),
    })
    if (others.length) fleetItems.push({ type: "separator" })
    for (const machine of others) {
      fleetItems.push({
        label: machine.online ? machine.name : `${machine.name} (Offline)`,
        type: "checkbox",
        checked: machine.subdomain === window.showingSubdomain,
        icon: statusDot(machine.online),
        click: () => (window.bringToFront(), void window.showMachine(machine.subdomain)),
      })
    }
    fleetItems.push(
      { type: "separator" },
      { label: "Manage Fleet…", click: () => void shell.openExternal(new URL("/fleet", fleet.site).toString()) }
    )
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.getName(),
      submenu: [
        { role: "about" },
        { label: "Check for Updates…", click: () => void checkForUpdatesNow() },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: () => (window.bringToFront(), window.go("/settings/general")) },
        { label: "Setup…", click: () => (window.bringToFront(), window.openSetup()) },
        {
          label: "Keep Mac Awake While Plugged In",
          type: "checkbox",
          checked: keepAwake.onPower,
          click: () => {
            keepAwake.onPower = !keepAwake.onPower
            rebuildMenu()
          },
        },
        { type: "separator" },
        { label: "Uninstall Kanna…", click: () => (window.bringToFront(), void confirmAndUninstall(window.win)) },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Reload", accelerator: "CmdOrCtrl+R", click: () => window.reload() },
        {
          label: "Open in Browser",
          click: () => {
            const url = window.currentURL ?? agent.serverURL
            if (url) void shell.openExternal(url)
          },
        },
        { type: "separator" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => window.actualSize() },
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => window.zoomIn() },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => window.zoomOut() },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      label: "History",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => window.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => window.goForward() },
      ],
    },
    {
      // In every build: forks, checkouts and second servers are ordinary.
      label: "Server",
      submenu: [
        { label: "Installed Kanna", type: "checkbox", checked: mode.kind === "installed", click: () => switchServer({ kind: "installed" }) },
        {
          label: "Development Checkout (bun run dev)",
          type: "checkbox",
          checked: mode.kind === "development",
          click: () => (checkout ? switchServer({ kind: "development" }) : void chooseCheckout().then(rebuildMenu)),
        },
        {
          label: mode.kind === "custom" ? `Custom URL: ${mode.url}…` : "Custom URL…",
          type: "checkbox",
          checked: mode.kind === "custom",
          click: () => void useCustomServer().then(rebuildMenu),
        },
        { type: "separator" },
        {
          label: checkout ? `Checkout: ${checkout.replace(os.homedir(), "~")}…` : "Choose Checkout…",
          click: () => void chooseCheckout(),
        },
      ],
    },
    { label: "Fleet", submenu: fleetItems },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        { label: "Kanna Website", click: () => void shell.openExternal("https://kanna.sh") },
        { label: "Show Server Log", click: () => void shell.openPath(agent.log.file) },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // "DEV" on the Dock icon while the window shows a checkout's server, so a
  // dev window is never mistaken for the real one.
  app.dock?.setBadge(mode.kind === "development" ? "DEV" : "")
}

/** The sidebar picker's online dot (src/client/app/MachineSwitcher.tsx):
 *  8pt, drawn at 2x. */
const dots = new Map<boolean, Electron.NativeImage>()
function statusDot(online: boolean) {
  const cached = dots.get(online)
  if (cached) return cached
  const size = 16
  const [red, green, blue, alpha] = online ? [52, 199, 89, 255] : [128, 128, 128, 110]
  const bitmap = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
      const coverage = Math.min(Math.max(size / 2 - distance, 0), 1)
      const a = (alpha * coverage) / 255
      const offset = (y * size + x) * 4
      // BGRA, premultiplied.
      bitmap[offset] = Math.round(blue * a)
      bitmap[offset + 1] = Math.round(green * a)
      bitmap[offset + 2] = Math.round(red * a)
      bitmap[offset + 3] = Math.round(255 * a)
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width: size, height: size, scaleFactor: 2 })
  dots.set(online, image)
  return image
}
