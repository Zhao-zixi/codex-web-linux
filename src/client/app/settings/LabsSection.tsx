import { useEffect, useState } from "react"
import { isNightlyVersion } from "../../../shared/types"
import { Switch } from "../../components/ui/switch"
import type { KannaState } from "../useKannaState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsActionButton, SettingsErrorBanner, SettingsGroup, SettingsRow } from "./shared"

export function LabsSection({
  state,
  appVersion,
}: {
  state: Pick<
    KannaState,
    | "appSettings"
    | "handleWriteAppSettings"
    | "updateSnapshot"
    | "handleInstallNightly"
    | "handleInstallStable"
    | "handleCheckForUpdates"
  >
  appVersion: string
}) {
  const { appSettings, handleWriteAppSettings, updateSnapshot } = state
  const [error, setError] = useState<string | null>(null)

  async function handleRecentChatsChange(enabled: boolean) {
    try {
      setError(null)
      await handleWriteAppSettings({ newSidebarEnabled: enabled })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  async function handleWebglRendererChange(enabled: boolean) {
    try {
      setError(null)
      await handleWriteAppSettings({ terminal: { webglRenderer: enabled } })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  const newSidebarEnabled = appSettings?.newSidebarEnabled !== false
  const webglRendererEnabled = appSettings?.terminal.webglRenderer === true

  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const onNightly = isNightlyVersion(currentVersionLabel)
  const nightly = updateSnapshot?.nightly
  const checkForUpdates = state.handleCheckForUpdates
  const nightlyStatusLabel = isUpdating
    ? "Update in progress…"
    : nightly?.status === "up_to_date"
      ? "Latest nightly installed"
      : nightly?.status === "available"
        ? "New nightly available"
        : nightly?.status === "checking"
          ? "Checking latest nightly…"
          : nightly?.status === "error"
            ? "Could not check latest nightly"
            : "Latest nightly not checked yet"

  useEffect(() => {
    if (onNightly) void checkForUpdates()
  }, [checkForUpdates, onNightly])

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <SettingsGroup>
        <SettingsRow
          def={SETTINGS_ROWS.nightlyBuilds}
          wideControl
          title={onNightly ? `Nightly Build ${currentVersionLabel}` : undefined}
          description={
            onNightly
              ? (
                <div className="flex flex-col gap-1">
                  <p role="status" className="font-medium text-foreground">{nightlyStatusLabel}</p>
                  {nightly?.latestCommitSha ? (
                    <p className="whitespace-nowrap">
                      Latest: <code>{nightly.latestCommitSha.slice(0, 7)}</code>
                      {nightly.lastCheckedAt ? ` as of ${new Date(nightly.lastCheckedAt).toLocaleTimeString()}` : null}
                    </p>
                  ) : nightly?.lastCheckedAt ? <p>Last checked {new Date(nightly.lastCheckedAt).toLocaleTimeString()}</p> : null}
                  {nightly?.error ? <p>{nightly.error}</p> : null}
                </div>
              )
              : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-x-4 @2xl:justify-end">
            {onNightly && nightly?.status !== "available" ? (
              <SettingsActionButton
                onClick={() => { void checkForUpdates({ force: true }) }}
                disabled={isUpdating || nightly?.status === "checking"}
              >
                Check again
              </SettingsActionButton>
            ) : null}
            {onNightly ? (
              <SettingsActionButton
                onClick={() => {
                  void state.handleInstallStable()
                }}
                disabled={isUpdating}
              >
                Back to stable
              </SettingsActionButton>
            ) : null}
            {!onNightly || nightly?.status !== "up_to_date" ? (
              <SettingsActionButton
                onClick={() => {
                  void state.handleInstallNightly()
                }}
                disabled={isUpdating}
              >
                {isUpdating ? "Updating…" : "Build latest"}
              </SettingsActionButton>
            ) : null}
          </div>
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.recentChatsInSidebar}>
          <Switch
            checked={newSidebarEnabled}
            onCheckedChange={(checked) => {
              void handleRecentChatsChange(checked)
            }}
            aria-label={SETTINGS_ROWS.recentChatsInSidebar.title}
          />
        </SettingsRow>
        <SettingsRow def={SETTINGS_ROWS.terminalWebglRenderer}>
          <Switch
            checked={webglRendererEnabled}
            onCheckedChange={(checked) => {
              void handleWebglRendererChange(checked)
            }}
            aria-label={SETTINGS_ROWS.terminalWebglRenderer.title}
          />
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}
