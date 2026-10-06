import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import type { SubscriptionTopic } from "../../shared/protocol"
import { trimTranscriptWindow } from "../../shared/transcript-window"
import type { ChatSnapshot } from "../../shared/types"
import { useSidebarStore } from "../stores/sidebarStore"
import { cachedWindowToMessages, persistWindow, readMemoryCachedWindow, rememberWindow } from "./chatTranscriptCache"
import { isProcessingStatus } from "./derived"
import { applyIncrementalChatSnapshot } from "./snapshotEquality"
import type { KannaSocket } from "./socket"

/**
 * How long a chat that stopped running stays subscribed. Longer than the
 * server's background push interval, so the push that carries the end of the
 * turn lands before the subscription goes.
 */
const STOPPED_CHAT_GRACE_MS = 3_000

type TranscriptWindow = Pick<ChatSnapshot, "messages" | "startIndex">

function useRunningChatIds(): string[] {
  return useSidebarStore(useShallow((state) => {
    const ids: string[] = []
    for (const group of state.data.projectGroups) {
      for (const chat of group.chats) {
        if (isProcessingStatus(chat.status)) ids.push(chat.chatId)
      }
    }
    return ids.sort()
  }))
}

function spanOf(window: TranscriptWindow | null) {
  const last = window?.messages[window.messages.length - 1]
  return window && last
    ? { start: window.startIndex, end: window.startIndex + window.messages.length, endEntryId: last._id }
    : null
}

/**
 * Follow one chat in the background, keeping its memory window current.
 *
 * Starts from the memory window when there is one, so the server answers with
 * a tail. The window is trimmed as it grows: nothing renders it, and a chat
 * that runs for an hour must not hold every entry it wrote.
 */
function followChatInBackground(
  socket: KannaSocket,
  chatId: string,
  windowSize: () => number,
): () => void {
  let held: TranscriptWindow | null = null
  let unsubscribe = () => {}

  const topicFor = (window: TranscriptWindow | null): SubscriptionTopic => {
    const span = spanOf(window)
    return { type: "chat", chatId, background: true, ...(span ? { cachedSpan: span } : {}) }
  }

  const subscribe = (seed: TranscriptWindow | null) => {
    held = seed
    unsubscribe = socket.subscribe<ChatSnapshot | null>(topicFor(seed), (snapshot) => {
      if (!snapshot) return
      const next = applyIncrementalChatSnapshot(held, snapshot)
      if (!next) {
        // A body that doesn't meet what is held. Start over without a span;
        // the full window that answers it is always placeable.
        unsubscribe()
        subscribe(null)
        return
      }
      held = trimTranscriptWindow({ messages: next.messages, startIndex: next.startIndex }, windowSize())
      if (isProcessingStatus(next.runtime.status)) {
        rememberWindow(chatId, held)
      } else {
        // Settled: also worth keeping across a reload.
        persistWindow(chatId, held)
      }
    }, undefined, {
      topicOnReconnect: () => topicFor(held),
    })
  }

  const memory = readMemoryCachedWindow(chatId)
  subscribe(memory ? trimTranscriptWindow(cachedWindowToMessages(memory), windowSize()) : null)
  return () => unsubscribe()
}

/**
 * Hold a subscription on every running chat except the open ones, so opening
 * a running chat paints from a current window and the server only has to send
 * what landed since the last background push. An open chat has its own
 * full-rate subscription, and the two never overlap. Open means the chat the
 * page is on, and the one in the previewer beside it (`previewChatId`).
 */
export function useBackgroundChatSubscriptions(
  socket: KannaSocket,
  activeChatId: string | null,
  windowSizeRef: React.RefObject<number>,
  previewChatId: string | null = null,
) {
  const runningChatIds = useRunningChatIds()
  const followedRef = useRef(new Map<string, { stop: () => void; dropTimer: ReturnType<typeof setTimeout> | null }>())

  useEffect(() => {
    const followed = followedRef.current
    const wanted = new Set(runningChatIds)
    if (activeChatId) wanted.delete(activeChatId)
    if (previewChatId) wanted.delete(previewChatId)

    for (const [chatId, entry] of followed) {
      if (wanted.has(chatId)) {
        if (entry.dropTimer !== null) clearTimeout(entry.dropTimer)
        entry.dropTimer = null
        continue
      }
      if (chatId === activeChatId || chatId === previewChatId) {
        if (entry.dropTimer !== null) clearTimeout(entry.dropTimer)
        entry.stop()
        followed.delete(chatId)
        continue
      }
      entry.dropTimer ??= setTimeout(() => {
        entry.stop()
        if (followed.get(chatId) === entry) followed.delete(chatId)
      }, STOPPED_CHAT_GRACE_MS)
    }

    for (const chatId of wanted) {
      if (followed.has(chatId)) continue
      followed.set(chatId, {
        stop: followChatInBackground(socket, chatId, () => windowSizeRef.current),
        dropTimer: null,
      })
    }
  }, [activeChatId, previewChatId, runningChatIds, socket, windowSizeRef])

  useEffect(() => () => {
    const followed = followedRef.current
    for (const entry of followed.values()) {
      if (entry.dropTimer !== null) clearTimeout(entry.dropTimer)
      entry.stop()
    }
    followed.clear()
  }, [socket])
}
