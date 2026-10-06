import { useMemo } from "react"
import {
  buildChatGraph,
  collectChatGraphRows,
  describeChatGraphStatus,
  resolveChatGraphRootId,
  type ChatGraph,
  type ChatGraphTone,
} from "../../lib/chat-graph"
import { useSidebarStore } from "../../stores/sidebarStore"

/**
 * The graph view's reads of the sidebar snapshot.
 *
 * The snapshot is pushed several times a second through a turn, and almost
 * none of those pushes change the shape of a tree. So each hook selects a
 * string that says only what it draws from, and the store's own equality
 * check drops every push that left that string alone.
 */

/**
 * The root of the tree a chat is in. Null while the sidebar has not heard of
 * the chat: before its first snapshot, and once the chat is deleted.
 */
export function useChatGraphRootId(chatId: string | null): string | null {
  return useSidebarStore((state) => (
    chatId ? resolveChatGraphRootId(collectChatGraphRows(state.data), chatId) : null
  ))
}

/** The tree a chat is in, kept as one object until its shape changes. */
export function useChatGraph(chatId: string | null): ChatGraph | null {
  const serialized = useSidebarStore((state) => {
    if (!chatId) return null
    const graph = buildChatGraph(collectChatGraphRows(state.data), chatId)
    return graph ? JSON.stringify(graph) : null
  })
  return useMemo(() => (serialized ? JSON.parse(serialized) as ChatGraph : null), [serialized])
}

/** How each chat in the tree is doing, for the edges. A node reads its own. */
export function useChatGraphTones(graph: ChatGraph | null): ReadonlyMap<string, ChatGraphTone> {
  const serialized = useSidebarStore((state) => {
    if (!graph) return ""
    const wanted = new Set(graph.nodes.map((node) => node.chatId))
    const tones: string[] = []
    for (const group of state.data.projectGroups) {
      for (const rows of [group.chats, group.archivedChats ?? []]) {
        for (const row of rows) {
          if (wanted.has(row.chatId)) tones.push(`${row.chatId} ${describeChatGraphStatus(row).tone}`)
        }
      }
    }
    return tones.join("\n")
  })
  return useMemo(() => new Map(
    serialized.split("\n").filter(Boolean).map((line) => {
      const separator = line.lastIndexOf(" ")
      return [line.slice(0, separator), line.slice(separator + 1) as ChatGraphTone]
    }),
  ), [serialized])
}
