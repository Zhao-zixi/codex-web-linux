import { create } from "zustand"
import type { ThreadStarter } from "../../shared/types"
import type { KannaSocket } from "../app/socket"

/**
 * Each chat's first prompt, for the Channels layout's thread list.
 *
 * The sidebar snapshot carries no message text (see `chat.getPreview`), so a
 * channel asks for these when it shows a chat. Kept for the page's lifetime:
 * a first prompt never changes.
 */

/** The server's cap on ids per request. */
const REQUEST_BATCH_SIZE = 200

interface ThreadStarterState {
  starters: Record<string, ThreadStarter>
  /**
   * Chats the server was asked about and has no prompt for. Only chats that
   * report a message are asked about, so this is a chat whose every prompt is
   * hidden, and asking again would get the same answer.
   */
  missing: Record<string, true>
  setStarter: (chatId: string, starter: ThreadStarter) => void
  addAnswer: (askedChatIds: string[], starters: Record<string, ThreadStarter>) => void
}

export const useThreadStarterStore = create<ThreadStarterState>()((set) => ({
  starters: {},
  missing: {},
  setStarter: (chatId, starter) => set((state) => ({ starters: { ...state.starters, [chatId]: starter } })),
  addAnswer: (askedChatIds, starters) => set((state) => {
    const missing = { ...state.missing }
    for (const chatId of askedChatIds) {
      if (!starters[chatId]) missing[chatId] = true
    }
    return { starters: { ...state.starters, ...starters }, missing }
  }),
}))

/** Asked for and not yet answered, so a re-render doesn't ask again. */
const inFlight = new Set<string>()

/** Fetches the starters this page hasn't asked for yet. */
export async function requestThreadStarters(socket: KannaSocket, chatIds: string[]) {
  const { starters, missing, addAnswer } = useThreadStarterStore.getState()
  const wanted = chatIds.filter((chatId) => !starters[chatId] && !missing[chatId] && !inFlight.has(chatId))
  for (let index = 0; index < wanted.length; index += REQUEST_BATCH_SIZE) {
    const batch = wanted.slice(index, index + REQUEST_BATCH_SIZE)
    for (const chatId of batch) inFlight.add(chatId)
    try {
      addAnswer(batch, await socket.command<Record<string, ThreadStarter>>({ type: "project.threadStarters", chatIds: batch }))
    } catch {
      // The list shows what it has. The next change to the channel asks again.
    } finally {
      for (const chatId of batch) inFlight.delete(chatId)
    }
  }
}
