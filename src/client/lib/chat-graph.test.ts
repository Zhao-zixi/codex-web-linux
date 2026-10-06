import { describe, expect, test } from "bun:test"
import type { KannaStatus, SidebarData } from "../../shared/types"
import {
  buildChatGraph,
  collectChatGraphRows,
  describeChatGraphStatus,
  resolveChatGraphRootId,
  type ChatGraphRow,
} from "./chat-graph"

function row(chatId: string, parentChatId?: string, createdAt = 0): ChatGraphRow {
  return { chatId, _creationTime: createdAt, ...(parentChatId ? { parentChatId } : {}) }
}

/**
 * root ─┬─ a ─┬─ a1
 *       │     └─ a2
 *       └─ b
 * plus an unrelated chat with a sub-chat of its own.
 */
const ROWS: ChatGraphRow[] = [
  row("b", "root", 20),
  row("a2", "a", 40),
  row("root", undefined, 0),
  row("a", "root", 10),
  row("a1", "a", 30),
  row("other", undefined, 5),
  row("other-child", "other", 6),
]

describe("resolveChatGraphRootId", () => {
  test("a chat with no parent is its own root", () => {
    expect(resolveChatGraphRootId(ROWS, "root")).toBe("root")
  })

  test("a leaf resolves to its top-most ancestor", () => {
    expect(resolveChatGraphRootId(ROWS, "a2")).toBe("root")
    expect(resolveChatGraphRootId(ROWS, "b")).toBe("root")
    expect(resolveChatGraphRootId(ROWS, "other-child")).toBe("other")
  })

  test("a chat the rows do not hold has no root", () => {
    expect(resolveChatGraphRootId(ROWS, "missing")).toBeNull()
  })

  test("a chat whose parent is gone heads its own graph", () => {
    expect(resolveChatGraphRootId([row("orphan", "deleted"), row("kid", "orphan")], "kid")).toBe("orphan")
  })

  test("a loop in the links ends rather than spinning", () => {
    const loop = [row("x", "y"), row("y", "x")]
    expect(resolveChatGraphRootId(loop, "x")).toBe("y")
    expect(resolveChatGraphRootId(loop, "y")).toBe("x")
  })
})

describe("buildChatGraph", () => {
  test("a leaf and its root give the same graph", () => {
    expect(buildChatGraph(ROWS, "a2")).toEqual(buildChatGraph(ROWS, "root"))
  })

  test("lists parents before children, siblings oldest first, to any depth", () => {
    const graph = buildChatGraph(ROWS, "a1")!
    expect(graph.rootId).toBe("root")
    expect(graph.nodes.map((node) => node.chatId)).toEqual(["root", "a", "a1", "a2", "b"])
    expect(graph.nodes.map((node) => node.depth)).toEqual([0, 1, 2, 2, 1])
    expect(graph.nodes.find((node) => node.chatId === "root")?.childIds).toEqual(["a", "b"])
    expect(graph.nodes.find((node) => node.chatId === "a")).toEqual({
      chatId: "a",
      parentChatId: "root",
      depth: 1,
      adopted: false,
      childIds: ["a1", "a2"],
    })
  })

  test("leaves other trees out", () => {
    const ids = buildChatGraph(ROWS, "root")!.nodes.map((node) => node.chatId)
    expect(ids).not.toContain("other")
    expect(ids).not.toContain("other-child")
  })

  test("a new sub-chat lands after its siblings and moves none of them", () => {
    const before = buildChatGraph(ROWS, "root")!
    const after = buildChatGraph([...ROWS, row("a3", "a", 50)], "root")!
    expect(after.nodes.find((node) => node.chatId === "a")?.childIds).toEqual(["a1", "a2", "a3"])
    expect(after.nodes.filter((node) => node.chatId !== "a3").map((node) => node.chatId))
      .toEqual(before.nodes.map((node) => node.chatId))
  })

  test("chats created in the same millisecond keep one order", () => {
    const rows = [row("root"), row("z", "root", 1), row("m", "root", 1)]
    expect(buildChatGraph(rows, "root")!.nodes.map((node) => node.chatId)).toEqual(["root", "m", "z"])
    expect(buildChatGraph([...rows].reverse(), "root")!.nodes.map((node) => node.chatId)).toEqual(["root", "m", "z"])
  })

  test("an adopted chat shows under the chat that adopted it, marked as adopted", () => {
    const adopted = ROWS.map((entry) => (
      entry.chatId === "other" ? { ...entry, parentChatId: "b", adopted: true as const } : entry
    ))
    const graph = buildChatGraph(adopted, "other-child")!
    expect(graph.rootId).toBe("root")
    expect(graph.nodes.map((node) => node.chatId)).toEqual(["root", "a", "a1", "a2", "b", "other", "other-child"])
    expect(graph.nodes.filter((node) => node.adopted).map((node) => node.chatId)).toEqual(["other"])
  })

  test("an adopted chat goes after the chats its parent started, however old it is", () => {
    // Older than a and b, and adopted by the root they were started under.
    const rows = [...ROWS, { ...row("veteran", "root", 1), adopted: true as const }]
    const before = buildChatGraph(ROWS, "root")!
    const after = buildChatGraph(rows, "root")!
    expect(after.nodes.find((node) => node.chatId === "root")?.childIds).toEqual(["a", "b", "veteran"])
    expect(after.nodes.slice(0, before.nodes.length)).toEqual(before.nodes.map((node) => (
      node.chatId === "root" ? { ...node, childIds: ["a", "b", "veteran"] } : node
    )))
  })

  test("a loop in the links draws each chat once", () => {
    const graph = buildChatGraph([row("x", "y"), row("y", "x"), row("z", "x")], "x")!
    expect(graph.nodes.map((node) => node.chatId)).toEqual(["y", "x", "z"])
  })

  test("a chat the rows do not hold has no graph", () => {
    expect(buildChatGraph(ROWS, "missing")).toBeNull()
  })
})

describe("collectChatGraphRows", () => {
  test("takes sub-chats and archived chats from every project", () => {
    const chat = (chatId: string, parentChatId?: string) => ({
      _id: chatId,
      _creationTime: 0,
      chatId,
      title: chatId,
      status: "idle" as const,
      unread: false,
      localPath: "/tmp/p",
      provider: null,
      hasAutomation: false,
      ...(parentChatId ? { parentChatId } : {}),
    })
    const group = (groupKey: string, chats: ReturnType<typeof chat>[], archivedChats?: ReturnType<typeof chat>[]) => ({
      groupKey,
      title: groupKey,
      realTitle: groupKey,
      localPath: `/tmp/${groupKey}`,
      chats,
      // The lists a project shows leave sub-chats out; the graph does not read them.
      previewChats: chats.filter((entry) => !entry.parentChatId),
      olderChats: [],
      ...(archivedChats ? { archivedChats } : {}),
      defaultCollapsed: false,
    })
    const data: SidebarData = {
      projectGroups: [
        group("one", [chat("root"), chat("kid", "root")], [chat("old", "root")]),
        group("two", [chat("far", "kid")]),
      ],
    }
    const graph = buildChatGraph(collectChatGraphRows(data), "far")!
    expect(graph.rootId).toBe("root")
    expect(graph.nodes.map((node) => node.chatId).sort()).toEqual(["far", "kid", "old", "root"])
  })
})

describe("describeChatGraphStatus", () => {
  const describeStatus = (status: KannaStatus, extra: { unread?: boolean; pendingToolKind?: string } = {}) =>
    describeChatGraphStatus({ status, unread: extra.unread ?? false, pendingToolKind: extra.pendingToolKind })

  test("every status reads as something", () => {
    const statuses: KannaStatus[] = ["idle", "starting", "running", "waiting_for_user", "waiting_on_subagent", "failed"]
    expect(statuses.map((status) => describeStatus(status))).toEqual([
      { tone: "idle", label: null },
      { tone: "working", label: "Starting" },
      { tone: "working", label: "Running" },
      { tone: "needs-user", label: "Needs you" },
      { tone: "waiting", label: "Waiting" },
      { tone: "failed", label: "Failed" },
    ])
  })

  test("waiting on a subagent is not running, and not at rest", () => {
    expect(describeStatus("waiting_on_subagent").tone).toBe("waiting")
    // Its turn ended, which marks it unread, but it has more to say.
    expect(describeStatus("waiting_on_subagent", { unread: true })).toEqual({ tone: "waiting", label: "Waiting" })
  })

  test("says what a chat waiting on the user is waiting for", () => {
    expect(describeStatus("waiting_for_user", { pendingToolKind: "exit_plan_mode" }).label).toBe("Plan ready")
    expect(describeStatus("waiting_for_user", { pendingToolKind: "ask_user_question" }).label).toBe("Asked you")
  })

  test("a chat at rest says only whether there is something new", () => {
    expect(describeStatus("idle", { unread: true })).toEqual({ tone: "unread", label: "Unread" })
    expect(describeStatus("idle")).toEqual({ tone: "idle", label: null })
  })

  test("a failure outranks an unread mark", () => {
    expect(describeStatus("failed", { unread: true })).toEqual({ tone: "failed", label: "Failed" })
  })
})
