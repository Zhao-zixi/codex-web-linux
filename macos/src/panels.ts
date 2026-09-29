import { app, BrowserWindow, ipcMain, type WebContents } from "electron"
import path from "node:path"

/**
 * The app's own pages (static/), which talk through panel-preload.ts. One
 * set of IPC handlers, routed by the sender, serves the overlay and every
 * sheet.
 */
interface Panel {
  init?: () => unknown
  action?: (id: string) => void
  done?: (result: unknown) => void
  resize?: (height: number) => void
}

const panels = new Map<number, Panel>()

ipcMain.handle("panel:init", (event) => panels.get(event.sender.id)?.init?.())
ipcMain.on("panel:action", (event, id: string) => panels.get(event.sender.id)?.action?.(id))
ipcMain.on("panel:done", (event, result: unknown) => panels.get(event.sender.id)?.done?.(result))
ipcMain.on("panel:resize", (event, height: number) => panels.get(event.sender.id)?.resize?.(height))

export function registerPanel(contents: WebContents, panel: Panel) {
  panels.set(contents.id, panel)
  contents.once("destroyed", () => panels.delete(contents.id))
}

// From the app's root (macos/, or app.asar packaged), not __dirname: Bun
// bakes __dirname into the bundle as the source folder.
export const staticFile = (name: string) => path.join(app.getAppPath(), "static", name)
export const builtFile = (name: string) => path.join(app.getAppPath(), "build", name)
export const panelPreload = builtFile("panel-preload.js")

/**
 * An alert with controls Electron's dialog lacks, as a sheet on `parent`.
 * Resolves what the page hands back, or null on Cancel.
 */
export function showSheet<T>(parent: BrowserWindow, kind: string, data: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    const sheet = new BrowserWindow({
      parent,
      modal: true,
      width: 420,
      height: 160,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: { preload: panelPreload, contextIsolation: true, sandbox: true },
    })
    let settled = false
    const finish = (result: T | null) => {
      if (settled) return
      settled = true
      resolve(result)
      if (!sheet.isDestroyed()) sheet.close()
    }
    registerPanel(sheet.webContents, {
      init: () => ({ kind, data }),
      done: (result) => finish(result as T | null),
      resize: (height) => {
        sheet.setContentSize(420, Math.max(80, height))
        sheet.show()
      },
    })
    sheet.on("closed", () => finish(null))
    void sheet.loadFile(staticFile("sheet.html"))
  })
}
