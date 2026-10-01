import { describe, expect, test } from "bun:test"
import type { SidebarChatRow, ThreadStarter } from "../../shared/types"
import { buildChannelFeed, formatChannelDayLabel, getChannelReplyCount } from "./channel-feed"

function chat(chatId: string, createdAt: number, { empty = false } = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: createdAt,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: null,
    ...(empty ? {} : { lastMessageAt: createdAt }),
  } as SidebarChatRow
}

function starter(createdAt: number): ThreadStarter {
  return { content: "hello", createdAt }
}

const NOON = new Date(2026, 9, 1, 12).getTime()
const HOUR = 60 * 60 * 1_000

describe("buildChannelFeed", () => {
  test("orders threads oldest first and groups them by day", () => {
    const chats = [chat("b", NOON), chat("a", NOON - 26 * HOUR), chat("c", NOON + HOUR)]
    const feed = buildChannelFeed(chats, {
      a: starter(NOON - 26 * HOUR),
      b: starter(NOON),
      c: starter(NOON + HOUR),
    }, 10)

    expect(feed.days.map((day) => day.threads.map((thread) => thread.chat.chatId))).toEqual([["a"], ["b", "c"]])
    expect(feed.wantedChatIds).toEqual([])
    expect(feed.hasMore).toBe(false)
  })

  test("leaves out chats with no message", () => {
    const feed = buildChannelFeed([chat("empty", NOON, { empty: true })], {}, 10)
    expect(feed.days).toEqual([])
    expect(feed.wantedChatIds).toEqual([])
  })

  test("asks for the starters it lacks and holds those threads back", () => {
    const feed = buildChannelFeed([chat("a", NOON), chat("b", NOON + HOUR)], { a: starter(NOON) }, 10)
    expect(feed.days[0]?.threads.map((thread) => thread.chat.chatId)).toEqual(["a"])
    expect(feed.wantedChatIds).toEqual(["b"])
  })

  test("windows to the newest chats", () => {
    const chats = [chat("old", NOON - HOUR), chat("new", NOON)]
    const feed = buildChannelFeed(chats, { old: starter(NOON - HOUR), new: starter(NOON) }, 1)
    expect(feed.days[0]?.threads.map((thread) => thread.chat.chatId)).toEqual(["new"])
    expect(feed.hasMore).toBe(true)
  })

  test("places a thread by its first prompt, not by when the chat was made", () => {
    const chats = [chat("made-first", NOON - HOUR), chat("made-second", NOON)]
    const feed = buildChannelFeed(chats, {
      "made-first": starter(NOON + HOUR),
      "made-second": starter(NOON),
    }, 10)
    expect(feed.days[0]?.threads.map((thread) => thread.chat.chatId)).toEqual(["made-second", "made-first"])
  })
})

describe("formatChannelDayLabel", () => {
  const today = new Date(2026, 9, 1).getTime()

  test("names today and yesterday", () => {
    expect(formatChannelDayLabel(today, NOON)).toBe("Today")
    expect(formatChannelDayLabel(new Date(2026, 8, 30).getTime(), NOON)).toBe("Yesterday")
  })

  test("adds the year only for another year", () => {
    expect(formatChannelDayLabel(new Date(2026, 8, 28).getTime(), NOON)).not.toContain("2026")
    expect(formatChannelDayLabel(new Date(2025, 8, 28).getTime(), NOON)).toContain("2025")
  })
})

describe("getChannelReplyCount", () => {
  test("counts each answer and each later prompt", () => {
    expect(getChannelReplyCount({ turnCount: 1 })).toBe(1)
    expect(getChannelReplyCount({ turnCount: 3 })).toBe(5)
  })

  test("says nothing without a turn count", () => {
    expect(getChannelReplyCount({})).toBeNull()
    expect(getChannelReplyCount({ turnCount: 0 })).toBeNull()
  })
})
