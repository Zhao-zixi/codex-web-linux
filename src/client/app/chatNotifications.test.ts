import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getChatNotificationEvents, getChatNotificationSnapshot, getNotificationTitleCount } from "./chatNotifications"

function row(overrides: Partial<SidebarChatRow> & Pick<SidebarChatRow, "chatId">): SidebarChatRow {
  return {
    _id: overrides.chatId,
    _creationTime: 1,
    title: overrides.chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/p",
    provider: "claude",
    hasAutomation: false,
    ...overrides,
  }
}

function sidebar(chats: SidebarChatRow[]): SidebarData {
  return { projectGroups: [{ groupKey: "p", title: "P", realTitle: "P", localPath: "/tmp/p", chats, previewChats: [], olderChats: [], defaultCollapsed: false }] }
}

describe("chat notifications and sub-chats", () => {
  // A sub-chat finishes for its parent, which reports the result in its own
  // turn. Telling the user as well would announce the same news twice, about
  // a chat the sidebar does not list.
  test("a sub-chat finishing is not counted or announced", () => {
    const before = sidebar([row({ chatId: "parent" }), row({ chatId: "child", parentChatId: "parent" })])
    const after = sidebar([row({ chatId: "parent" }), row({ chatId: "child", parentChatId: "parent", unread: true })])
    expect(getNotificationTitleCount(after)).toBe(0)
    expect(getChatNotificationSnapshot(after).unreadCount).toBe(0)
    expect(getChatNotificationEvents(before, after)).toEqual([])
  })

  test("its parent finishing still is", () => {
    const before = sidebar([row({ chatId: "parent" }), row({ chatId: "child", parentChatId: "parent" })])
    const after = sidebar([row({ chatId: "parent", unread: true }), row({ chatId: "child", parentChatId: "parent" })])
    expect(getNotificationTitleCount(after)).toBe(1)
    expect(getChatNotificationEvents(before, after).map((event) => event.chatId)).toEqual(["parent"])
  })

  // The one thing a sub-chat does want the user for.
  test("a sub-chat that stops to ask something is announced", () => {
    const before = sidebar([row({ chatId: "child", parentChatId: "parent", status: "running" })])
    const after = sidebar([row({ chatId: "child", parentChatId: "parent", status: "waiting_for_user" })])
    expect(getNotificationTitleCount(after)).toBe(1)
    expect(getChatNotificationEvents(before, after).map((event) => event.chatId)).toEqual(["child"])
  })
})
