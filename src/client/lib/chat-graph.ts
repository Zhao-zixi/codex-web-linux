import type { KannaStatus, SidebarChatRow, SidebarData } from "../../shared/types"

/**
 * A chat and the chats started under it, as a tree: what the graph view
 * (`/graph/:chatId`) draws. Built from the parent link every sidebar row
 * carries (`SidebarChatRow.parentChatId`). Kept React-free for tests.
 */

export type ChatGraphRow = Pick<SidebarChatRow, "chatId" | "parentChatId" | "_creationTime" | "adopted">

export interface ChatGraphNode {
  chatId: string
  /** Null on the root. */
  parentChatId: string | null
  /** 0 for the root. */
  depth: number
  /**
   * Its parent took it on (`SidebarChatRow.adopted`) and did not start it.
   * Drawn apart, since such a chat is often one the user began.
   */
  adopted: boolean
  /** Oldest first. */
  childIds: string[]
}

export interface ChatGraph {
  rootId: string
  /** Every chat in the tree, parents before their children. */
  nodes: ChatGraphNode[]
}

/**
 * Every chat the sidebar snapshot holds. Archived ones too: an archived
 * sub-chat is still part of what its parent did, and leaving it out would
 * cut its own sub-chats loose from the tree.
 */
export function collectChatGraphRows(data: SidebarData): ChatGraphRow[] {
  const rows: ChatGraphRow[] = []
  for (const group of data.projectGroups) {
    for (const row of group.chats) rows.push(row)
    for (const row of group.archivedChats ?? []) rows.push(row)
  }
  return rows
}

/**
 * The top-most ancestor of a chat: the one with no parent. The chat itself
 * when it has none. Null for a chat the rows do not hold.
 *
 * A parent that is gone (deleted) ends the walk where it is, so the chat
 * under it heads its own graph. A send can make the sender a chat's parent
 * (`adopt`), so the links are followed with a guard: a loop ends at the last
 * chat reached before it would repeat.
 */
export function resolveChatGraphRootId(rows: readonly ChatGraphRow[], chatId: string): string | null {
  const byId = new Map(rows.map((row) => [row.chatId, row]))
  let current = byId.get(chatId)
  if (!current) return null
  const seen = new Set<string>([current.chatId])
  while (current.parentChatId) {
    const parent = byId.get(current.parentChatId)
    if (!parent || seen.has(parent.chatId)) break
    seen.add(parent.chatId)
    current = parent
  }
  return current.chatId
}

/**
 * The tree a chat belongs to, from its root down, whichever chat in it was
 * asked for. Null for a chat the rows do not hold.
 *
 * Children are ordered oldest first, by when they were created. That order
 * never changes for a chat once it exists, so a new sub-chat always lands
 * after its siblings and the layout only ever grows at the end of a list.
 *
 * Adopted chats come after the ones their parent started. An adopted chat
 * can be older than every sibling it joins, and by age alone it would land
 * at the head of the list and push all of them down.
 */
export function buildChatGraph(rows: readonly ChatGraphRow[], chatId: string): ChatGraph | null {
  const rootId = resolveChatGraphRootId(rows, chatId)
  if (!rootId) return null

  const childrenByParent = new Map<string, ChatGraphRow[]>()
  for (const row of rows) {
    if (!row.parentChatId || row.chatId === rootId) continue
    const siblings = childrenByParent.get(row.parentChatId)
    if (siblings) siblings.push(row)
    else childrenByParent.set(row.parentChatId, [row])
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => (
      Number(Boolean(a.adopted)) - Number(Boolean(b.adopted))
      || a._creationTime - b._creationTime
      || a.chatId.localeCompare(b.chatId)
    ))
  }

  const nodes: ChatGraphNode[] = []
  const placed = new Set<string>()
  const visit = (id: string, parentChatId: string | null, depth: number, adopted: boolean) => {
    placed.add(id)
    const node: ChatGraphNode = { chatId: id, parentChatId, depth, adopted, childIds: [] }
    nodes.push(node)
    for (const child of childrenByParent.get(id) ?? []) {
      // A chat already in the tree is not added again: that is a loop in the links.
      if (placed.has(child.chatId)) continue
      node.childIds.push(child.chatId)
      visit(child.chatId, id, depth + 1, Boolean(child.adopted))
    }
  }
  visit(rootId, null, 0, false)
  return { rootId, nodes }
}

/** How a chat's state reads on its node, at a glance and from far out. */
export type ChatGraphTone =
  /** A turn in flight. */
  | "working"
  /** Waiting on work it handed off. */
  | "waiting"
  /** Waiting on the user. */
  | "needs-user"
  | "failed"
  /** At rest, with a reply the user has not read. */
  | "unread"
  | "idle"

export interface ChatGraphStatus {
  tone: ChatGraphTone
  /** The state in a word or two. Null at rest with nothing new: the node shows its age. */
  label: string | null
}

/**
 * What a node says about its chat's status.
 *
 * Every status has a word here, where the sidebar row has only a glyph for
 * some and nothing for a failure: a row is one of a list you read down, and a
 * node is read from across a canvas, often zoomed out.
 */
export function describeChatGraphStatus(
  row: Pick<SidebarChatRow, "status" | "unread" | "pendingToolKind">,
): ChatGraphStatus {
  const status: KannaStatus = row.status
  switch (status) {
    case "starting":
      return { tone: "working", label: "Starting" }
    case "running":
      return { tone: "working", label: "Running" }
    case "waiting_on_subagent":
      return { tone: "waiting", label: "Waiting" }
    case "waiting_for_user":
      return {
        tone: "needs-user",
        label: row.pendingToolKind === "exit_plan_mode"
          ? "Plan ready"
          : row.pendingToolKind === "ask_user_question" ? "Asked you" : "Needs you",
      }
    case "failed":
      return { tone: "failed", label: "Failed" }
    case "idle":
      return row.unread ? { tone: "unread", label: "Unread" } : { tone: "idle", label: null }
    default: {
      // A status added to `KannaStatus` without a case here fails the build.
      const unhandled: never = status
      return { tone: "idle", label: String(unhandled) }
    }
  }
}
