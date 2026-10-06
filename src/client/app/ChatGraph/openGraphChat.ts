import { useCallback } from "react"
import type { ChatJumpRole } from "../../lib/chat-navigation"
import { useOpenChat } from "../useOpenChat"

/**
 * What a node opens on the graph's own page (`/graph/:chatId`): the
 * `ChatGraphHost.openChat` that page gives its canvas. The graph in the
 * previewer's pane has its own, in `GraphViewer`.
 *
 * It is the app's one way to open a chat from inside another chat's view
 * (`useOpenChat`), so a node behaves as a chat link or a Tasks row does. The
 * head of the graph is the page's own chat, which cannot be previewed beside
 * itself, so it is gone to; every chat under it opens in the previewer beside the graph;
 * Cmd/Ctrl-click and middle-click give it a tab. `jump` lands on one end of
 * the chat's last exchange.
 *
 * Call it from the click handler itself: `useOpenChat` reads the click in
 * flight for its modifier.
 */
export function useOpenGraphChat(): (chatId: string, jump?: ChatJumpRole) => void {
  const openChat = useOpenChat()
  return useCallback((chatId, jump) => openChat(chatId, jump ? { jump } : undefined), [openChat])
}

/**
 * Router state for the graph route: the chat that was asked for, when the
 * graph shown is its root's. Carried beside the URL, like a jump into a chat
 * (`chat-navigation.ts`), because the URL names the graph and this only says
 * where in it the reader came in.
 */
export interface ChatGraphLocationState {
  graphRequestedChatId: string
}

export function buildChatGraphLocationState(requestedChatId: string): ChatGraphLocationState {
  return { graphRequestedChatId: requestedChatId }
}

export function readChatGraphRequestedChatId(state: unknown): string | null {
  if (!state || typeof state !== "object") return null
  const { graphRequestedChatId } = state as Partial<ChatGraphLocationState>
  return typeof graphRequestedChatId === "string" && graphRequestedChatId ? graphRequestedChatId : null
}
