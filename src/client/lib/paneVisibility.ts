import type { AppSettingsSnapshot, PaneVisibilityScope } from "../../shared/types"
import { useAppSettingsStore } from "../stores/appSettingsStore"

export type PaneKind = keyof AppSettingsSnapshot["paneVisibility"]

/**
 * The chat whose own entry a pane's open state lives under, or null when it
 * follows the project's: the setting says per project, or there's no chat to
 * key by (a project page with no chat open).
 */
export function paneChatKey(scope: PaneVisibilityScope, chatId: string | null | undefined) {
  return scope === "chat" ? chatId ?? null : null
}

// Per chat until the settings snapshot lands, the server's default too.
function scopeFor(settings: AppSettingsSnapshot | null, pane: PaneKind): PaneVisibilityScope {
  return settings?.paneVisibility?.[pane] ?? "chat"
}

/** Reactive `paneChatKey` for this pane's setting. */
export function usePaneChatKey(pane: PaneKind, chatId: string | null | undefined) {
  const scope = useAppSettingsStore((store) => scopeFor(store.settings, pane))
  return paneChatKey(scope, chatId)
}

/** `paneChatKey` read once, for handlers outside render. */
export function getPaneChatKey(pane: PaneKind, chatId: string | null | undefined) {
  return paneChatKey(scopeFor(useAppSettingsStore.getState().settings, pane), chatId)
}
