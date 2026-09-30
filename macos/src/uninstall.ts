import { app, dialog, type BrowserWindow } from "electron"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { disableLoginItem } from "./mac-setup"
import { quitNow } from "./quit"
import { showSheet } from "./panels"
import { shellEnv } from "./shell-env"

/**
 * Kanna › Uninstall Kanna…: removes Kanna from this Mac, with a choice of
 * what goes with it. The removing is macos/uninstall.sh, bundled with the
 * app, the same script that works by hand. It deletes the app and stops its server, so the app starts it and
 * quits; the script waits for the app to exit and logs to
 * /tmp/kanna-uninstall.log.
 */
interface Choice {
  id: string
  title: string
  checked: boolean
  /** Added when checked. */
  flag?: string
  /** Added when unchecked. */
  keepFlag?: string
}

const KEEP: Choice[] = [
  { id: "cli", title: "The kanna command (kanna-code)", checked: true, keepFlag: "--keep-cli" },
  { id: "data", title: "Chats, projects and settings (~/.kanna)", checked: true, keepFlag: "--keep-data" },
  { id: "cloud", title: "This Mac's Kanna Cloud address", checked: true, keepFlag: "--keep-cloud" },
  // Off by default: Bun may be the user's own, not the one Kanna installed.
  { id: "bun", title: "Bun (~/.bun)", checked: false, keepFlag: "--keep-bun" },
]

const AGENTS: Choice[] = [
  { id: "claude", title: "Claude Code", checked: false, flag: "--claude" },
  { id: "codex", title: "Codex", checked: false, flag: "--codex" },
  { id: "cursor", title: "Cursor CLI", checked: false, flag: "--cursor" },
  { id: "gh", title: "GitHub CLI", checked: false, flag: "--gh" },
  { id: "grok", title: "Grok", checked: false, flag: "--grok" },
]

export async function confirmAndUninstall(window: BrowserWindow) {
  const picked = await showSheet<Record<string, boolean>>(window, "uninstall", {
    message: `${app.getName()} and its preferences are removed, along with Kanna for Mac. Choose what else goes.`,
    keep: KEEP,
    agents: AGENTS,
  })
  if (!picked) return
  const flags: string[] = []
  for (const choice of [...KEEP, ...AGENTS]) {
    if (picked[choice.id]) {
      if (choice.flag) flags.push(choice.flag)
    } else if (choice.keepFlag) {
      flags.push(choice.keepFlag)
    }
  }
  await start(window, flags)
}

async function start(window: BrowserWindow, flags: string[]) {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, "uninstall.sh")
    : path.resolve(app.getAppPath(), "..", "macos", "uninstall.sh")
  // Out of the bundle, which the script deletes while it runs.
  const script = path.join(os.tmpdir(), "kanna-uninstall.sh")
  try {
    fs.copyFileSync(bundled, script)
  } catch (error) {
    await failed(window, String(error))
    return
  }

  // The login item is the app's own; only it can remove it cleanly.
  disableLoginItem()

  const args = [script, "--yes", "--after-pid", String(process.pid), ...flags]
  // Unpackaged, the "app" is Electron.app in node_modules: never hand that over.
  if (app.isPackaged) args.push("--app", path.resolve(process.execPath, "..", "..", ".."))
  const log = fs.openSync("/tmp/kanna-uninstall.log", "w")
  try {
    const child = spawn("/bin/bash", args, {
      // The login shell's PATH, so it finds the npm or bun each CLI came from.
      env: await shellEnv(),
      stdio: ["ignore", log, log],
      detached: true,
    })
    child.unref()
  } catch (error) {
    await failed(window, String(error))
    return
  }
  // Stop the app's server without asking (the script stops a terminal's).
  // The script waits for the app to go.
  void quitNow("goOffline")
}

async function failed(window: BrowserWindow, message: string) {
  await dialog.showMessageBox(window, { type: "warning", message: "Kanna couldn't start the uninstall", detail: message })
}
