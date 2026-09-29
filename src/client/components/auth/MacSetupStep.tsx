import { useEffect, type ReactNode } from "react"
import { Check, Coffee, HardDrive, Power } from "lucide-react"
import {
  macSetup,
  macSetupAvailable,
  useMacSetupStore,
  type MacSetupState,
} from "../../lib/macApp"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { Switch } from "../ui/switch"

/**
 * The setup wizard's This Mac step, shown only in Kanna for Mac, on this
 * Mac's own server: Open at Login, staying awake, and Full Disk Access. The
 * page draws it; the app does each thing and reports back
 * (macos/Kanna/MacSetup.swift). A browser, or an app older than the step,
 * never sees it.
 */
export { macSetupAvailable }

/** Nothing left to do: the step can be skipped on open. */
export function macSetupSatisfied(state: MacSetupState | null) {
  return state !== null && state.loginItem === "enabled" && state.fullDiskAccess
}

/** Re-reads the live state every second while mounted, so a switch flipped in System Settings shows up. */
export function useMacSetupState(enabled: boolean) {
  const state = useMacSetupStore((store) => store.state)
  useEffect(() => {
    if (!enabled) return
    macSetup.refresh()
    const timer = window.setInterval(macSetup.refresh, 1000)
    return () => window.clearInterval(timer)
  }, [enabled])
  return state
}

function Card({ icon, title, action, children }: {
  icon: ReactNode
  title: string
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon}
          <span className="truncate text-sm font-semibold text-foreground">{title}</span>
        </div>
        {action}
      </div>
      {children ? <div className="mt-2 space-y-1.5">{children}</div> : null}
    </div>
  )
}

function Note({ tone = "muted", children }: { tone?: "muted" | "warn"; children: ReactNode }) {
  return (
    <p className={cn("text-xs leading-5", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
      {children}
    </p>
  )
}

function PillButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-7 shrink-0 rounded-full px-3 text-xs font-semibold"
    >
      {children}
    </Button>
  )
}

function Granted() {
  return (
    <span className="flex shrink-0 items-center pr-2" title="Done">
      <Check className="h-4 w-4 text-emerald-500" />
    </span>
  )
}

/** What to do in System Settings once Open Settings takes you there. */
export const FULL_DISK_ACCESS_STEPS = "In the list, click +, choose Kanna in Applications, then turn it on."

export function MacSetupCards({ state }: { state: MacSetupState | null }) {
  if (!state) {
    return <p className="text-center text-sm text-muted-foreground">Checking this Mac…</p>
  }
  const iconClass = "h-4 w-4 shrink-0 text-foreground"

  return (
    <div className="space-y-3">
      <Card
        icon={<Power className={iconClass} />}
        title="Open Kanna at login"
        action={state.loginItem === "requiresApproval" ? (
          <PillButton onClick={macSetup.openLoginItems}>Open Login Items</PillButton>
        ) : (
          <Switch
            aria-label="Open Kanna at login"
            checked={state.loginItem === "enabled"}
            onCheckedChange={macSetup.setLoginItem}
          />
        )}
      >
        {state.loginItem === "requiresApproval" ? (
          <Note tone="warn">Turn Kanna on under Login Items to finish.</Note>
        ) : (
          <Note>Keeps your agents, and this Mac's Kanna Cloud address, going after a restart.</Note>
        )}
      </Card>

      <Card
        icon={<Coffee className={iconClass} />}
        title="Keep this Mac awake"
        action={
          <Switch
            aria-label="Keep this Mac awake while plugged in"
            checked={state.keepAwakeOnPower}
            onCheckedChange={(onPower) => macSetup.setKeepAwake({ onPower })}
          />
        }
      >
        <Note>
          While plugged in. A locked Mac keeps working; a sleeping one doesn't. The display still turns off and
          locks as usual.
        </Note>
        <div className="flex items-center justify-between gap-3 pt-0.5">
          <span className={cn("text-xs", state.keepAwakeOnPower ? "text-foreground" : "text-muted-foreground")}>
            Also on battery
          </span>
          <Switch
            aria-label="Also on battery"
            checked={state.keepAwakeOnBattery}
            disabled={!state.keepAwakeOnPower}
            onCheckedChange={(onBattery) => macSetup.setKeepAwake({ onBattery })}
          />
        </div>
        {!state.pluggedIn && !(state.keepAwakeOnPower && state.keepAwakeOnBattery) ? (
          <Note tone="warn">On battery: this Mac sleeps when idle until it's plugged in.</Note>
        ) : null}
        {state.lidClosingSleeps ? (
          <Note tone="warn">Closing the lid sleeps this Mac. Keep it open, or connect a display to run it closed.</Note>
        ) : null}
        <Note>
          {state.fileVault === false
            ? "After a restart, Kanna comes back once you log in, or by itself with automatic login."
            : "After a restart, Kanna comes back once you log in."}
        </Note>
      </Card>

      <Card
        icon={<HardDrive className={iconClass} />}
        title="Full Disk Access"
        action={state.fullDiskAccess ? <Granted /> : (
          <PillButton onClick={macSetup.openFullDiskAccess}>Open Settings</PillButton>
        )}
      >
        {state.fullDiskAccess ? (
          <Note>Agents can work on projects anywhere in your home folder.</Note>
        ) : (
          <>
            <Note>
              Without it, macOS stops your agents to ask about Desktop, Documents, Downloads and iCloud Drive, one
              folder at a time.
            </Note>
            <Note>{FULL_DISK_ACCESS_STEPS}</Note>
          </>
        )}
      </Card>
    </div>
  )
}
