import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import { computeChannelSections, getChannelPeekGroups } from "./channel-sections"

const NOW = new Date(2026, 9, 1, 12).getTime()
const DAY = 24 * 60 * 60 * 1_000

function chat(chatId: string, at: number, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: at,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: null,
    lastMessageAt: at,
    ...extra,
  } as SidebarChatRow
}

function project(groupKey: string, chats: SidebarChatRow[]): SidebarProjectGroup {
  return { groupKey, title: groupKey, realTitle: groupKey, localPath: `/tmp/${groupKey}`, chats } as SidebarProjectGroup
}

function sectionsOf(groups: SidebarProjectGroup[], pins: Record<string, number> = {}) {
  const pinned = groups.map((group) => (
    pins[group.groupKey] === undefined ? group : { ...group, pinnedAt: pins[group.groupKey] }
  ))
  return computeChannelSections(pinned, NOW)
    .map((section) => [section.label, section.groups.map((group) => group.groupKey)])
}

describe("computeChannelSections", () => {
  test("puts a project in the section of its highest-priority chat", () => {
    expect(sectionsOf([
      project("yesterday-and-older", [chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)]),
      project("today-and-relevant", [chat("c", NOW), chat("d", NOW - 9 * DAY, { unread: true })]),
      project("running", [chat("e", NOW - DAY, { status: "running" }), chat("f", NOW)]),
      project("today", [chat("g", NOW)]),
    ])).toEqual([
      ["In Progress", ["running"]],
      ["Relevant", ["today-and-relevant"]],
      ["Today", ["today"]],
      ["Yesterday", ["yesterday-and-older"]],
    ])
  })

  test("pins a project only when the channel itself is pinned", () => {
    expect(sectionsOf([
      project("has-pinned-chat", [chat("a", NOW, { pinnedAt: 5 })]),
      project("pinned-channel", [chat("b", NOW - DAY, { status: "running" })]),
      project("plain", [chat("c", NOW - DAY)]),
    ], { "pinned-channel": 10 })).toEqual([
      ["Pinned", ["pinned-channel"]],
      ["Today", ["has-pinned-chat"]],
      ["Yesterday", ["plain"]],
    ])
  })

  test("keeps projects with no chats to show reachable at the end", () => {
    expect(sectionsOf([
      project("empty", []),
      project("unsent", [chat("a", NOW, { lastMessageAt: undefined })]),
      project("active", [chat("b", NOW)]),
    ])).toEqual([
      ["Today", ["active"]],
      ["No Recent Chats", ["empty", "unsent"]],
    ])
  })

})

describe("getChannelPeekGroups", () => {
  function peek(chats: SidebarChatRow[]) {
    return getChannelPeekGroups(project("p", chats), NOW)
      .map((group) => [group.label, group.threads.map((thread) => thread.chatId)])
  }

  test("offers everything down to Relevant, then the latest date bucket only", () => {
    expect(peek([
      chat("pinned", NOW - 9 * DAY, { pinnedAt: 1 }),
      chat("running", NOW, { status: "running" }),
      chat("unread", NOW - DAY, { unread: true }),
      chat("today", NOW),
      chat("yesterday", NOW - DAY),
    ])).toEqual([
      ["In Progress", ["running"]],
      ["Relevant", ["unread"]],
      ["Pinned", ["pinned"]],
      ["Today", ["today"]],
    ])
  })

  test("is the latest day alone for a project with nothing pressing", () => {
    expect(peek([chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)])).toEqual([["Yesterday", ["a"]]])
  })

  test("adds the older buckets when asked for all of them", () => {
    const groups = getChannelPeekGroups(
      project("p", [chat("a", NOW - DAY), chat("b", NOW - 9 * DAY)]), NOW, undefined, undefined, true,
    )
    expect(groups.map((group) => group.threads.map((thread) => thread.chatId))).toEqual([["a"], ["b"]])
  })

  test("is empty for a project with no chats to show", () => {
    expect(peek([chat("unsent", NOW, { lastMessageAt: undefined })])).toEqual([])
  })
})
