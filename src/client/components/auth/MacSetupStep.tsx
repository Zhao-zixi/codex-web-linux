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
 * (macos/src/mac-setup.ts). A browser, or an app older than the step,
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

/**
 * The wizard's card: rows in one rounded card with hairlines between them,
 * the way Settings groups its rows (app/settings/shared.tsx
 * SETTINGS_LIST_CARD_CLASS), rather than a stack of separate boxes.
 */
export const SETUP_LIST_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40 text-left"

export function SetupList({ children, className }: { children: ReactNode; className?: string }) {
  return <div data-setup-list className={cn(SETUP_LIST_CLASS, className)}>{children}</div>
}

/** One row: icon, a title with at most one short line under it, and its control. */
export function SetupRow({ icon, title, detail, tone = "muted", action, nested = false, muted = false, className }: {
  icon?: ReactNode
  title: string
  detail?: ReactNode
  tone?: "muted" | "warn"
  action: ReactNode
  nested?: boolean
  /** Skipped or not done: the row steps back. */
  muted?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex items-center gap-3 px-4 py-3", nested && "pl-11", className)}>
      {icon ? (
        <span className={cn("flex size-4 shrink-0 items-center justify-center", muted ? "text-muted-foreground/50" : "text-foreground")}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className={cn("truncate text-sm", nested || muted ? "text-muted-foreground" : "font-medium text-foreground")}>{title}</div>
        {detail ? (
          <div className={cn("mt-0.5 text-xs", tone === "warn" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground")}>
            {detail}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{action}</div>
    </div>
  )
}

export function PillButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-7 shrink-0 rounded-full px-3 text-xs font-semibold transition-[transform,background-color] duration-150 ease-out active:scale-[0.96]"
    >
      {children}
    </Button>
  )
}

/** The check a row lands on; it settles in rather than blinking on. */
export function Done() {
  return (
    <span className="flex size-7 items-center justify-center" title="Done">
      <Check className="size-4 text-emerald-500 animate-in fade-in zoom-in-90 duration-200 ease-out" />
    </span>
  )
}

/** What to do in System Settings once Open Settings takes you there. */
export const FULL_DISK_ACCESS_STEPS = "Click +, then choose Kanna."

export function MacSetupCards({ state }: { state: MacSetupState | null }) {
  if (!state) {
    return <p className="text-center text-sm text-muted-foreground">Checking this Mac…</p>
  }
  const iconClass = "size-4"

  return (
    <SetupList>
      <SetupRow
        icon={<Power className={iconClass} />}
        title="Open at login"
        detail={state.loginItem === "requiresApproval" ? "Approve Kanna in Login Items." : "Back after a restart."}
        tone={state.loginItem === "requiresApproval" ? "warn" : "muted"}
        action={state.loginItem === "requiresApproval" ? (
          <PillButton onClick={macSetup.openLoginItems}>Open</PillButton>
        ) : (
          <Switch
            aria-label="Open at login"
            checked={state.loginItem === "enabled"}
            onCheckedChange={macSetup.setLoginItem}
          />
        )}
      />
      <SetupRow
        icon={<Coffee className={iconClass} />}
        title="Stay awake"
        detail={state.lidClosingSleeps ? "Closing the lid still sleeps it." : "While plugged in."}
        tone={state.lidClosingSleeps ? "warn" : "muted"}
        action={
          <Switch
            aria-label="Stay awake while plugged in"
            checked={state.keepAwakeOnPower}
            onCheckedChange={(onPower) => macSetup.setKeepAwake({ onPower })}
          />
        }
      />
      {state.keepAwakeOnPower ? (
        <SetupRow
          nested
          // Opens out of the row above it, the switch that made it appear.
          className="animate-in fade-in slide-in-from-top-1 duration-200 ease-out"
          title="Also on battery"
          action={
            <Switch
              aria-label="Also on battery"
              checked={state.keepAwakeOnBattery}
              onCheckedChange={(onBattery) => macSetup.setKeepAwake({ onBattery })}
            />
          }
        />
      ) : null}
      <SetupRow
        icon={<HardDrive className={iconClass} />}
        title="Full Disk Access"
        detail={state.fullDiskAccess ? "Agents reach every folder." : FULL_DISK_ACCESS_STEPS}
        action={state.fullDiskAccess ? <Done /> : (
          <PillButton onClick={macSetup.openFullDiskAccess}>Open Settings</PillButton>
        )}
      />
    </SetupList>
  )
}
