import { create } from "zustand"
import {
  closeChatTab,
  closeChatTabsToRight,
  closeOtherChatTabs,
  openChatTab,
  pruneChatTabs,
  reorderChatTabs,
  MAX_CHAT_TABS,
  type ChatTab,
} from "../lib/chat-tabs"
import { CHAT_TABS_STORAGE_KEY } from "../lib/storageKeys"

/**
 * The chat tabs, kept in this browser: they are how one
 * window is arranged, not something another device should inherit. The rules
 * are in `lib/chat-tabs`.
 */

interface ChatTabsState {
  tabs: ChatTab[]
  /**
   * The chats you have been on, most recent first: what closing the open tab
   * goes back to. This page's memory only, not stored: after a reload there
   * is no "before" yet.
   *
   * Here and not in the tab bar, which does not live long enough to hold it:
   * the chat page rebuilds its navbar whenever the open chat's project
   * changes, and a history kept in the bar was lost on exactly the switches
   * it was for.
   */
  recentChatIds: string[]
  visit: (chatId: string) => void
  open: (chatId: string, afterChatId?: string | null) => void
  close: (chatId: string) => void
  closeOthers: (chatId: string) => void
  closeToRight: (chatId: string) => void
  reorder: (orderedChatIds: string[]) => void
  prune: (keep: (chatId: string) => boolean) => void
}

function readStoredTabs(): ChatTab[] {
  if (typeof window === "undefined") return []
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CHAT_TABS_STORAGE_KEY) ?? "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => (
      item && typeof item === "object" && typeof (item as ChatTab).chatId === "string"
        ? [{ chatId: (item as ChatTab).chatId }]
        : []
    ))
  } catch {
    return []
  }
}

export const useChatTabsStore = create<ChatTabsState>()((set) => {
  // Every change goes through here: unchanged tabs (the rules hand back the
  // same array) neither re-render anything nor touch storage.
  const update = (change: (tabs: ChatTab[]) => ChatTab[]) => set((state) => {
    const tabs = change(state.tabs)
    if (tabs === state.tabs) return state
    if (typeof window !== "undefined") window.localStorage.setItem(CHAT_TABS_STORAGE_KEY, JSON.stringify(tabs))
    return { tabs }
  })

  return {
    tabs: readStoredTabs(),
    recentChatIds: [],
    visit: (chatId) => set((state) => (
      state.recentChatIds[0] === chatId
        ? state
        : { recentChatIds: [chatId, ...state.recentChatIds.filter((recent) => recent !== chatId)].slice(0, MAX_CHAT_TABS) }
    )),
    open: (chatId, afterChatId) => update((tabs) => openChatTab(tabs, chatId, afterChatId)),
    close: (chatId) => update((tabs) => closeChatTab(tabs, chatId)),
    closeOthers: (chatId) => update((tabs) => closeOtherChatTabs(tabs, chatId)),
    closeToRight: (chatId) => update((tabs) => closeChatTabsToRight(tabs, chatId)),
    reorder: (orderedChatIds) => update((tabs) => reorderChatTabs(tabs, orderedChatIds)),
    prune: (keep) => update((tabs) => pruneChatTabs(tabs, keep)),
  }
})
