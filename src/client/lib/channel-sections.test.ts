import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarProjectGroup } from "../../shared/types"
import { computeChannelSections } from "./channel-sections"

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
  return computeChannelSections(groups, NOW, pins)
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

  test("ignores a pin for a project that is gone", () => {
    expect(sectionsOf([project("active", [chat("a", NOW)])], { gone: 1 })).toEqual([["Today", ["active"]]])
  })
})
