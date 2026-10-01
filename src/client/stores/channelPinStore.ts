import { create } from "zustand"
import type { ChannelPins } from "../lib/channel-sections"
import { CHANNEL_PINS_STORAGE_KEY } from "../lib/storageKeys"

/**
 * Which channels are pinned in the Channels sidebar.
 *
 * Kept in this browser, unlike a chat's pin: the server records pins on chats
 * and has no notion of a pinned project.
 */

interface ChannelPinState {
  pins: ChannelPins
  toggle: (projectId: string) => void
}

function readStoredPins(): ChannelPins {
  if (typeof window === "undefined") return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CHANNEL_PINS_STORAGE_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number")
    )
  } catch {
    return {}
  }
}

export const useChannelPinStore = create<ChannelPinState>()((set) => ({
  pins: readStoredPins(),
  toggle: (projectId) => set((state) => {
    const { [projectId]: pinnedAt, ...rest } = state.pins
    const pins = pinnedAt == null ? { ...state.pins, [projectId]: Date.now() } : rest
    if (typeof window !== "undefined") window.localStorage.setItem(CHANNEL_PINS_STORAGE_KEY, JSON.stringify(pins))
    return { pins }
  }),
}))
