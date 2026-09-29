import { Check } from "lucide-react"
import { FULL_DISK_ACCESS_STEPS, useMacSetupState } from "../../components/auth/MacSetupStep"
import { Button } from "../../components/ui/button"
import { Switch } from "../../components/ui/switch"
import { macSetup } from "../../lib/macApp"
import { SETTINGS_ROWS } from "./registry"
import { SettingsGroup, SettingsGroups, SettingsPlaceholder, SettingsRow } from "./shared"

/**
 * Settings › This Mac, in Kanna for Mac only: the setup wizard's This Mac
 * step (MacSetupStep), for after setup. The app does each thing and reports
 * the live state back (macos/Kanna/MacSetup.swift), re-read every second so
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
          inlineControl
          description={state.loginItem === "requiresApproval"
            ? "macOS wants this approved: turn Kanna on under Login Items to finish."
            : undefined}
        >
          {state.loginItem === "requiresApproval" ? (
            <Button variant="outline" size="sm" onClick={macSetup.openLoginItems}>
              Open Login Items
            </Button>
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
          inlineControl
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
          inlineControl
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
            <Button variant="outline" size="sm" onClick={macSetup.openFullDiskAccess}>
              Open Privacy Settings
            </Button>
          )}
        </SettingsRow>
      </SettingsGroup>
    </SettingsGroups>
  )
}
