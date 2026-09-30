import { app, powerMonitor, powerSaveBlocker, shell } from "electron"
import { execFile, spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import { readPrefs, writePrefs } from "./prefs"

/**
 * Keeps the Mac awake while Kanna runs, so it stays reachable from kanna.sh,
 * the iOS app or a Tailscale address with the screen locked.
 *
 * Locking (⌃⌘Q) never stopped Kanna: the session and its processes keep
 * running behind the login window. Idle sleep does. So the app holds
 * "prevent-app-suspension", the PreventUserIdleSystemSleep assertion
 * `caffeinate -i` takes, instead of changing the Mac's energy settings: it
 * needs no admin password, the display still turns off and locks on its
 * usual timers, and it ends when Kanna quits. By default it only holds on
 * the power adapter, so a laptop on battery still sleeps.
 */
class KeepAwake {
  private blocker: number | null = null

  get onPower() {
    return readPrefs().keepAwakeOnPower ?? true
  }

  set onPower(value: boolean) {
    writePrefs({ keepAwakeOnPower: value })
    this.update()
  }

  get onBattery() {
    return readPrefs().keepAwakeOnBattery ?? false
  }

  set onBattery(value: boolean) {
    writePrefs({ keepAwakeOnBattery: value })
    this.update()
  }

  start() {
    powerMonitor.on("on-ac", () => this.update())
    powerMonitor.on("on-battery", () => this.update())
    this.update()
    this.takeBack()
  }

  /**
   * Keep Online (quit.ts): the app's assertion ends when it quits, so hand
   * it to `caffeinate`, which holds one for as long as the server runs.
   * -s holds only on the power adapter, the default; -i on battery too.
   */
  handOff(serverPid: number) {
    const flag = this.onPower && this.onBattery ? "-i" : this.onPower ? "-s" : null
    if (!flag) return
    try {
      const child = spawn("/usr/bin/caffeinate", [flag, "-w", String(serverPid)], { detached: true, stdio: "ignore" })
      child.unref()
      if (child.pid) writePrefs({ caffeinatePid: child.pid })
    } catch {}
  }

  /** Open again, the app holds the assertion itself, and follows the switches. */
  private takeBack() {
    const pid = readPrefs().caffeinatePid
    if (!pid) return
    writePrefs({ caffeinatePid: undefined })
    // Only if that pid is still the caffeinate: pids get reused.
    execFile("/bin/ps", ["-p", String(pid), "-o", "comm="], (error, stdout) => {
      if (error || !stdout.trim().endsWith("caffeinate")) return
      try {
        process.kill(pid)
      } catch {}
    })
  }

  private update() {
    const wanted = isOnPowerAdapter() ? this.onPower : this.onPower && this.onBattery
    if (wanted && this.blocker === null) {
      this.blocker = powerSaveBlocker.start("prevent-app-suspension")
    } else if (!wanted && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
  }
}

export const keepAwake = new KeepAwake()

/** Desktops always report the adapter. */
function isOnPowerAdapter() {
  return !powerMonitor.isOnBatteryPower()
}

/** Null on a Mac without a lid. False when a display is connected, which lets
 *  a laptop run closed (clamshell mode). IOKit's AppleClamshellCausesSleep,
 *  read through ioreg since Electron has no IOKit. */
function lidClosingSleeps() {
  return new Promise<boolean | null>((resolve) => {
    execFile("/usr/sbin/ioreg", ["-r", "-c", "IOPMrootDomain", "-d", "1"], { maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      const match = error ? null : stdout.match(/"AppleClamshellCausesSleep"\s*=\s*(Yes|No)/)
      resolve(match ? match[1] === "Yes" : null)
    })
  })
}

/** With FileVault, macOS asks for a password after every restart before any
 *  login item (Kanna included) can start. */
function isFileVaultOn() {
  return new Promise<boolean>((resolve) => {
    execFile("/usr/bin/fdesetup", ["status"], (error, stdout) => resolve(!error && stdout.includes("FileVault is On")))
  })
}

/** Open at Login, registered with SMAppService. With it, a restart brings the
 *  server (and, when paired, this Mac's kanna.sh address) back without anyone
 *  opening the app. */
const loginItem = {
  status(): "enabled" | "requiresApproval" | "off" {
    const settings = app.getLoginItemSettings()
    if (settings.status === "enabled") return "enabled"
    if (settings.status === "requires-approval") return "requiresApproval"
    return settings.status === undefined && settings.openAtLogin ? "enabled" : "off"
  },
  set(enabled: boolean) {
    app.setLoginItemSettings({ openAtLogin: enabled })
  },
  openSettings() {
    void shell.openExternal("x-apple.systempreferences:com.apple.LoginItems-Settings.extension")
  },
}

export function disableLoginItem() {
  loginItem.set(false)
}

/** Full Disk Access: try to open a file TCC guards. EPERM is the "no"; a file
 *  that doesn't exist says nothing, so try the next one. One grant to the app
 *  covers the server and everything it spawns. */
const fullDiskAccess = {
  isGranted() {
    const home = os.homedir()
    for (const guarded of [
      `${home}/Library/Application Support/com.apple.TCC/TCC.db`,
      `${home}/Library/Safari/Bookmarks.plist`,
      `${home}/Library/Mail`,
    ]) {
      try {
        fs.closeSync(fs.openSync(guarded, "r"))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return false
      }
    }
    return false
  },
  openSettings() {
    void shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
  },
}

/**
 * The Mac half of the web setup wizard's "This Mac" step
 * (src/client/components/auth/MacSetupStep.tsx) and Settings › This Mac: the
 * page sends `macSetup.*` messages and this answers with the live state. The
 * page asks again every second or so while the step is up, so a switch
 * flipped in System Settings shows without a click. The caller checks that
 * the message came from this Mac's own server.
 */
let fileVault: boolean | null = null
void isFileVaultOn().then((on) => {
  fileVault = on
})

export async function handleMacSetup(type: string, body: Record<string, unknown>) {
  switch (type) {
    case "macSetup.setLoginItem":
      loginItem.set(body.enabled !== false)
      break
    case "macSetup.openLoginItems":
      loginItem.openSettings()
      break
    case "macSetup.setKeepAwake":
      if (typeof body.onPower === "boolean") keepAwake.onPower = body.onPower
      if (typeof body.onBattery === "boolean") keepAwake.onBattery = body.onBattery
      break
    case "macSetup.openFullDiskAccess":
      fullDiskAccess.openSettings()
      break
    case "macSetup.setQuitBehavior":
      writePrefs({
        quitBehavior: body.value === "keepOnline" || body.value === "goOffline" ? body.value : undefined,
      })
      break
  }
  return macSetupState()
}

export async function macSetupState() {
  return {
    loginItem: loginItem.status(),
    keepAwakeOnPower: keepAwake.onPower,
    keepAwakeOnBattery: keepAwake.onBattery,
    pluggedIn: isOnPowerAdapter(),
    lidClosingSleeps: await lidClosingSleeps(),
    fileVault,
    fullDiskAccess: fullDiskAccess.isGranted(),
    quitBehavior: readPrefs().quitBehavior ?? "ask",
  }
}
