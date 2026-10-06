import { useEffect } from "react"
import { CHANNEL_PINS_STORAGE_KEY } from "../lib/storageKeys"
import { getSidebarProjectGroups } from "../stores/sidebarStore"
import type { KannaSocket } from "./socket"

/**
 * Carries this browser's own pinned channels over to the server, once.
 *
 * Pinned projects used to be kept per browser, so a pin made here was not
 * there in the iOS app or another browser. The server keeps them now. A
 * browser that still holds some sends each to the server with the time it
 * was pinned, which keeps their order, and then forgets them.
 *
 * Waits for the sidebar: a pin for a project that is gone is dropped rather
 * than sent, and one the server already has is left alone. The stored pins
 * go only once every send has landed, so a failed one is tried again on the
 * next load rather than lost.
 */
export function useMigrateChannelPins(socket: KannaSocket, sidebarReady: boolean) {
  useEffect(() => {
    if (!sidebarReady) return
    const stored = window.localStorage.getItem(CHANNEL_PINS_STORAGE_KEY)
    if (stored === null) return

    let pins: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(stored)
      pins = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {}
    } catch {
      pins = {}
    }

    const groupsById = new Map(getSidebarProjectGroups().map((group) => [group.groupKey, group]))
    const sends = Object.entries(pins).flatMap(([projectId, pinnedAt]) => {
      const group = groupsById.get(projectId)
      if (!group || group.pinnedAt != null || typeof pinnedAt !== "number") return []
      return [socket.command({ type: "project.setPinned", projectId, pinned: true, pinnedAt })]
    })
    void Promise.all(sends)
      .then(() => window.localStorage.removeItem(CHANNEL_PINS_STORAGE_KEY))
      .catch(() => {})
  }, [sidebarReady, socket])
}
