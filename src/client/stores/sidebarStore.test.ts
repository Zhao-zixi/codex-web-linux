import { beforeEach, describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { getSidebarProjectGroups, findSidebarChat, parentChatIdOf, useSidebarStore } from "./sidebarStore"

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: "Chat",
    status: "idle",
    unread: false,
    localPath: "/repo",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function group(groupKey: string, chats: SidebarChatRow[] = [row(`${groupKey}-a`)]): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/repo/${groupKey}`,
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
  }
}

function data(groups: SidebarProjectGroup[]): SidebarData {
  return { projectGroups: groups }
}

describe("sidebarStore", () => {
  beforeEach(() => {
    useSidebarStore.setState({
      data: { projectGroups: [] },
      ready: false,
      optimisticProjectOrder: null,
    })
  })

  test("marks itself ready on the first snapshot", () => {
    expect(useSidebarStore.getState().ready).toBe(false)
    useSidebarStore.getState().setSnapshot(data([group("p1")]))
    expect(useSidebarStore.getState().ready).toBe(true)
  })

  test("keeps the held snapshot when a push changes nothing", () => {
    const { setSnapshot } = useSidebarStore.getState()
    setSnapshot(data([group("p1"), group("p2")]))
    const held = useSidebarStore.getState().data

    setSnapshot(data([group("p1"), group("p2")]))

    // Identity is what lets every row below stay memoized.
    expect(useSidebarStore.getState().data).toBe(held)
  })

  test("keeps untouched groups when one chat moves", () => {
    const { setSnapshot } = useSidebarStore.getState()
    setSnapshot(data([group("p1", [row("a")]), group("p2")]))
    const held = useSidebarStore.getState().data

    setSnapshot(data([
      group("p1", [row("a", { turnCount: 3 })]),
      group("p2"),
    ]))

    const next = useSidebarStore.getState().data
    expect(next).not.toBe(held)
    expect(next.projectGroups[1]).toBe(held.projectGroups[1])
  })

  test("applies an optimistic reorder immediately", () => {
    const { setSnapshot, setOptimisticProjectOrder } = useSidebarStore.getState()
    setSnapshot(data([group("p1"), group("p2")]))

    setOptimisticProjectOrder(["p2", "p1"])

    expect(getSidebarProjectGroups().map((item) => item.groupKey)).toEqual(["p2", "p1"])
  })

  test("holds the optimistic order across a push that has not caught up", () => {
    const { setSnapshot, setOptimisticProjectOrder } = useSidebarStore.getState()
    setSnapshot(data([group("p1"), group("p2")]))
    setOptimisticProjectOrder(["p2", "p1"])

    setSnapshot(data([group("p1"), group("p2")]))

    expect(getSidebarProjectGroups().map((item) => item.groupKey)).toEqual(["p2", "p1"])
    expect(useSidebarStore.getState().optimisticProjectOrder).toEqual(["p2", "p1"])
  })

  test("drops the optimistic order once the server echoes it", () => {
    const { setSnapshot, setOptimisticProjectOrder } = useSidebarStore.getState()
    setSnapshot(data([group("p1"), group("p2")]))
    setOptimisticProjectOrder(["p2", "p1"])

    setSnapshot(data([group("p2"), group("p1")]))

    expect(useSidebarStore.getState().optimisticProjectOrder).toBeNull()
    expect(getSidebarProjectGroups().map((item) => item.groupKey)).toEqual(["p2", "p1"])
  })

  test("finds a chat row for handlers that must not subscribe", () => {
    useSidebarStore.getState().setSnapshot(data([group("p1", [row("a", { unread: true })])]))

    expect(findSidebarChat("a")?.unread).toBe(true)
    expect(findSidebarChat("missing")).toBeNull()
  })

  test("reads a chat's parent from its row, archived or not", () => {
    const snapshot = data([
      group("p1", [row("parent"), row("child", { parentChatId: "parent" })]),
      { ...group("p2", [row("other")]), archivedChats: [row("put-away", { parentChatId: "other" })] },
    ])

    expect(parentChatIdOf(snapshot, "child")).toBe("parent")
    expect(parentChatIdOf(snapshot, "put-away")).toBe("other")
    // A chat of the user's own, a chat the snapshot does not hold, and no chat at all.
    expect(parentChatIdOf(snapshot, "parent")).toBeNull()
    expect(parentChatIdOf(snapshot, "missing")).toBeNull()
    expect(parentChatIdOf(snapshot, null)).toBeNull()
  })
})
