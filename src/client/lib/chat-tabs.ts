/**
 * Chat tabs: which chats are open in the navbar, in what
 * order. React-free for tests; `chatTabsStore` holds and persists the result.
 */

/** An object rather than a bare id, so a tab can carry more than its chat later without a new stored format. */
export interface ChatTab {
  chatId: string
}

/** More than anyone reads across; the oldest tabs fall off the front past it. */
export const MAX_CHAT_TABS = 40

/**
 * A chat was opened. One already in the bar is left where it is. A new one
 * goes right of the chat it was opened from (`afterChatId`), as a browser's
 * does, or at the end.
 */
export function openChatTab(tabs: readonly ChatTab[], chatId: string, afterChatId?: string | null): ChatTab[] {
  if (tabs.some((tab) => tab.chatId === chatId)) return tabs as ChatTab[]
  const opened: ChatTab = { chatId }
  const afterIndex = afterChatId ? tabs.findIndex((tab) => tab.chatId === afterChatId) : -1
  const next = afterIndex === -1
    ? [...tabs, opened]
    : [...tabs.slice(0, afterIndex + 1), opened, ...tabs.slice(afterIndex + 1)]
  return next.length > MAX_CHAT_TABS ? next.slice(next.length - MAX_CHAT_TABS) : next
}

export function closeChatTab(tabs: readonly ChatTab[], chatId: string): ChatTab[] {
  return tabs.filter((tab) => tab.chatId !== chatId)
}

/** Every tab but this one. */
export function closeOtherChatTabs(tabs: readonly ChatTab[], chatId: string): ChatTab[] {
  const kept = tabs.filter((tab) => tab.chatId === chatId)
  return kept.length === tabs.length || kept.length === 0 ? (tabs as ChatTab[]) : kept
}

/** The tabs after this one in the bar. */
export function closeChatTabsToRight(tabs: readonly ChatTab[], chatId: string): ChatTab[] {
  const index = tabs.findIndex((tab) => tab.chatId === chatId)
  return index === -1 || index === tabs.length - 1 ? (tabs as ChatTab[]) : tabs.slice(0, index + 1)
}

/**
 * The tab that takes over when one closes: the one to its right, or to its
 * left for the last tab. Null when it was the only one.
 */
export function getChatTabAfterClose(tabs: readonly ChatTab[], chatId: string): string | null {
  const index = tabs.findIndex((tab) => tab.chatId === chatId)
  if (index === -1) return null
  return (tabs[index + 1] ?? tabs[index - 1])?.chatId ?? null
}

/** The next or previous tab, wrapping at the ends. Null with fewer than two. */
export function getAdjacentChatTab(tabs: readonly ChatTab[], chatId: string | null, direction: 1 | -1): string | null {
  if (tabs.length < 2) return null
  const index = tabs.findIndex((tab) => tab.chatId === chatId)
  if (index === -1) return tabs[0]!.chatId
  return tabs[(index + direction + tabs.length) % tabs.length]!.chatId
}

/** The tabs in a new order. Unchanged if the order doesn't name them all. */
export function reorderChatTabs(tabs: readonly ChatTab[], orderedChatIds: readonly string[]): ChatTab[] {
  const byId = new Map(tabs.map((tab) => [tab.chatId, tab]))
  const ordered = orderedChatIds.flatMap((chatId) => {
    const tab = byId.get(chatId)
    return tab ? [tab] : []
  })
  return ordered.length === tabs.length ? ordered : (tabs as ChatTab[])
}

/** Drops tabs for chats that are gone. Same array back when none are. */
export function pruneChatTabs(tabs: readonly ChatTab[], keep: (chatId: string) => boolean): ChatTab[] {
  const kept = tabs.filter((tab) => keep(tab.chatId))
  return kept.length === tabs.length ? (tabs as ChatTab[]) : kept
}
