import { Check } from "lucide-react"
import { FULL_DISK_ACCESS_STEPS, useMacSetupState } from "../../components/auth/MacSetupStep"
import { SelectItem } from "../../components/ui/select"
import { Switch } from "../../components/ui/switch"
import { macSetup, type MacQuitBehavior } from "../../lib/macApp"
import { SETTINGS_ROWS } from "./registry"
import { SettingsActionButton, SettingsGroup, SettingsGroups, SettingsPlaceholder, SettingsRow, SettingsSelect } from "./shared"

const QUIT_BEHAVIOR_OPTIONS: { value: MacQuitBehavior; label: string }[] = [
  { value: "ask", label: "Ask" },
  { value: "keepOnline", label: "Keep Running" },
  { value: "goOffline", label: "Stop Kanna" },
]

/**
 * Settings › This Mac, in Kanna for Mac only: the setup wizard's This Mac
 * step (MacSetupStep), for after setup. The app does each thing and reports
 * the live state back (macos/src/mac-setup.ts), re-read every second so
 * a switch flipped in System Settings shows here too.
 */
export function MacSection() {
  const state = useMacSetupState(true)

  if (!state) {
    return <SettingsPlaceholder loading>Checking this Mac…</SettingsPlaceholder>
  }

  return (
    <SettingsGroups>
      <SettingsGroup title="Staying Online">
        <SettingsRow
          def={SETTINGS_ROWS.openAtLogin}
          description={state.loginItem === "requiresApproval"
            ? "macOS wants this approved: turn Kanna on under Login Items to finish."
            : undefined}
        >
          {state.loginItem === "requiresApproval" ? (
            <SettingsActionButton onClick={macSetup.openLoginItems}>
              Open Login Items
            </SettingsActionButton>
          ) : (
            <Switch
              checked={state.loginItem === "enabled"}
              onCheckedChange={macSetup.setLoginItem}
              aria-label={SETTINGS_ROWS.openAtLogin.title}
            />
          )}
        </SettingsRow>
        <SettingsRow
          def={SETTINGS_ROWS.keepAwake}
          description={
            <>
              {SETTINGS_ROWS.keepAwake.description}
              {state.lidClosingSleeps ? (
                <span className="mt-1 block text-amber-600 dark:text-amber-400">
                  Closing the lid sleeps this Mac. Keep it open, or connect a display to run it closed.
                </span>
              ) : null}
            </>
          }
        >
          <Switch
            checked={state.keepAwakeOnPower}
            onCheckedChange={(onPower) => macSetup.setKeepAwake({ onPower })}
            aria-label={SETTINGS_ROWS.keepAwake.title}
          />
        </SettingsRow>
        <SettingsRow
          def={SETTINGS_ROWS.keepAwakeOnBattery}
          nested
          description={!state.pluggedIn && !state.keepAwakeOnBattery
            ? "On battery now: this Mac sleeps when idle until it's plugged in."
            : undefined}
        >
          {/* Shows what's in effect: with Keep Awake off, nothing stays awake
              on battery either, so this slides off. The saved choice is
              kept, and it slides back on with Keep Awake. */}
          <Switch
            checked={state.keepAwakeOnPower && state.keepAwakeOnBattery}
            disabled={!state.keepAwakeOnPower}
            onCheckedChange={(onBattery) => macSetup.setKeepAwake({ onBattery })}
            aria-label={SETTINGS_ROWS.keepAwakeOnBattery.title}
          />
        </SettingsRow>
        {state.quitBehavior ? (
          <SettingsRow def={SETTINGS_ROWS.quitBehavior}>
            <SettingsSelect
              value={state.quitBehavior}
              onValueChange={(value) => macSetup.setQuitBehavior(value as MacQuitBehavior)}
            >
              {QUIT_BEHAVIOR_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SettingsSelect>
          </SettingsRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Permissions">
        <SettingsRow
          def={SETTINGS_ROWS.fullDiskAccess}
          alignStart
          description={
            <>
              {SETTINGS_ROWS.fullDiskAccess.description}
              {state.fullDiskAccess ? null : <span className="mt-1 block">{FULL_DISK_ACCESS_STEPS}</span>}
            </>
          }
        >
          {state.fullDiskAccess ? (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Check className="h-4 w-4 text-emerald-500" />
              Granted
            </span>
          ) : (
            <SettingsActionButton onClick={macSetup.openFullDiskAccess}>
              Open Privacy Settings
            </SettingsActionButton>
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsGroups>
  )
}
