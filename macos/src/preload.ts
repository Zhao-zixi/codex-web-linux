import { contextBridge, ipcRenderer } from "electron"

/**
 * The page's side of the app. The client finds Kanna for Mac through
 * `window.webkit.messageHandlers.kanna` and `window.__kannaMacApp`
 * (src/client/lib/macApp.ts). The first name comes from the WKWebView the
 * app used to be; it stays because the page is the user's npm install and
 * ships apart from the app, so older pages keep finding it.
 *
 * The pushes into the page (`__kannaFleet`, `__kannaMacSetup`) run in its
 * world from window.ts, and notifications are Chromium's own.
 */
interface Chrome {
  fullScreen: boolean
  vars: Record<string, string>
}

const initial = ipcRenderer.sendSync("kanna:initial") as { chrome: Chrome; version: string; features: string[] }

contextBridge.exposeInMainWorld("webkit", {
  messageHandlers: {
    kanna: {
      postMessage: (message: unknown) => ipcRenderer.send("kanna:message", message),
    },
  },
})

contextBridge.exposeInMainWorld("__kannaMacApp", { version: initial.version, features: initial.features })

// The window's shape, for src/index.css's `mac-app:` variant. The DOM is
// shared with the page, so this world can set it directly.
let chrome = initial.chrome
function applyChrome() {
  const root = document.documentElement
  if (!root) return false
  root.classList.add("kanna-mac-app")
  for (const [name, value] of Object.entries(chrome.vars)) root.style.setProperty(name, value)
  root.classList.toggle("kanna-mac-fullscreen", chrome.fullScreen)
  return true
}

if (!applyChrome()) {
  const observer = new MutationObserver(() => {
    if (applyChrome()) observer.disconnect()
  })
  observer.observe(document, { childList: true })
}

ipcRenderer.on("kanna:chrome", (_event, next: Chrome) => {
  chrome = next
  applyChrome()
})

// Title-bar areas the page marks with data-window-drag drag the window;
// anything clickable inside them stays clickable. Decided by the element
// under the mouse, so a control pinned over a title bar from elsewhere (the
// sidebar toggle beside the traffic lights) is never covered. main.ts drags
// natively (native-window.ts). The DOM is shared, so this world's listeners
// see the page's events.
const controls =
  "button, a, input, textarea, select, summary, label, [role=button], [role=menuitem], [role=tab], [contenteditable], [data-no-window-drag]"
const inTitleBar = (event: MouseEvent) => {
  const target = event.target
  return (
    event.button === 0 &&
    target instanceof Element &&
    target.closest("[data-window-drag]") !== null &&
    target.closest(controls) === null
  )
}
addEventListener(
  "mousedown",
  (event) => {
    if (!inTitleBar(event)) return
    // The second press of a double-click is the title bar's double-click;
    // the first is a drag, which may never hand the page its mouseup.
    if (event.detail === 1) ipcRenderer.send("kanna:window-drag")
    else if (event.detail === 2) ipcRenderer.send("kanna:window-double-click")
  },
  true
)
