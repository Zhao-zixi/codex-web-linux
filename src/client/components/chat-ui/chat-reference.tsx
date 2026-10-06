import { createContext, useContext, useMemo, type ReactNode } from "react"
import type { ChatSchedule } from "../../../shared/types"
import { flattenSidebarThreads, type SidebarThread } from "../../lib/thread-sections"
import { useSidebarStore } from "../../stores/sidebarStore"
import type { SidebarChatCardActions } from "./sidebar/ChatHoverCard"
import type { ThreadRowMenuActions } from "./sidebar/ThreadRow"

/**
 * What it takes to show another chat from inside a chat: the card where an
 * agent started or messaged it, and its row in the Tasks widget.
 *
 * A chat shown there is the same chat the sidebar lists, so it gets the same
 * right-click menu and the same hover card, doing the same things. This
 * carries the handlers those need down from the page that has them, rather
 * than threading a dozen props through the transcript and the widget column.
 *
 * Absent outside a chat page (the standalone export, the demo), where a
 * reference draws as plain text with nothing to open.
 */
export interface ChatReferenceActions {
  editorLabel: string
  menu: ThreadRowMenuActions
  card: SidebarChatCardActions
  /**
   * Opens a chat the way a click on it should: in the previewer when it has
   * a parent, in the main view otherwise (`useOpenChat`).
   */
  onOpenChat: (chatId: string) => void
  /** Opens it in the main view whatever it is: as a tab, with chat tabs on. */
  onOpenChatInTab: (chatId: string) => void
}

const ChatReferenceContext = createContext<ChatReferenceActions | null>(null)

export function ChatReferenceProvider({ value, children }: { value: ChatReferenceActions; children: ReactNode }) {
  return <ChatReferenceContext.Provider value={value}>{children}</ChatReferenceContext.Provider>
}

export function useChatReferenceActions(): ChatReferenceActions | null {
  return useContext(ChatReferenceContext)
}

/**
 * The open chat's schedules, for a schedule's card in the transcript: the
 * live record behind the call that set it, and the same Edit the Schedules
 * widget offers. Apart from the actions above because this one changes, each
 * time a schedule runs, and only schedule cards should re-render for that.
 */
export interface ChatSchedulesValue {
  chatId: string | null
  schedules: readonly ChatSchedule[]
  onEdit: (schedule: ChatSchedule) => void
}

const ChatSchedulesContext = createContext<ChatSchedulesValue | null>(null)

export function ChatSchedulesProvider({ value, children }: { value: ChatSchedulesValue; children: ReactNode }) {
  return <ChatSchedulesContext.Provider value={value}>{children}</ChatSchedulesContext.Provider>
}

export function useChatSchedules(): ChatSchedulesValue | null {
  return useContext(ChatSchedulesContext)
}

/**
 * One chat as the sidebar knows it: title, status, harness, project. Null
 * while the sidebar has not heard of it, and once it is deleted.
 *
 * Read from the sidebar's snapshot rather than from the chat's own, because
 * that is the one snapshot every chat is in from app start. Subscribed by
 * project group: a group keeps its identity until a chat inside it changes, so
 * a card re-renders for news about its own project and nothing else.
 */
export function useSidebarThread(chatId: string | null | undefined): SidebarThread | null {
  const group = useSidebarStore((state) => {
    if (!chatId) return null
    return state.data.projectGroups.find((candidate) => (
      candidate.chats.some((chat) => chat.chatId === chatId)
      || (candidate.archivedChats ?? []).some((chat) => chat.chatId === chatId)
    )) ?? null
  })
  return useMemo(
    () => (group ? flattenSidebarThreads({ projectGroups: [group] }).find((thread) => thread.chatId === chatId) ?? null : null),
    [chatId, group],
  )
}
