import type { SidebarChatRow, ThreadStarter } from "../../shared/types"

/**
 * The Channels layout's thread list: a project's chats, each shown as its
 * first prompt, oldest at the top and newest above the composer.
 */

/** How many threads a channel shows before you scroll up for more. */
export const CHANNEL_PAGE_SIZE = 40

const DAY_MS = 24 * 60 * 60 * 1_000

export interface ChannelThread {
  chat: SidebarChatRow
  starter: ThreadStarter
}

export interface ChannelDay {
  /** Local midnight of the day, which is also the React key. */
  startMs: number
  threads: ChannelThread[]
}

export interface ChannelFeed {
  days: ChannelDay[]
  /** Chats in the window with no starter held yet: what to ask the server for. */
  wantedChatIds: string[]
  /** Older chats exist beyond the window. */
  hasMore: boolean
}

function startOfLocalDay(timestampMs: number) {
  const date = new Date(timestampMs)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/**
 * A chat with no message is not a thread yet: New Chat makes one before you
 * type, and it has nothing to show as the thread's message.
 *
 * The window is the newest `limit` chats by creation, since that is known for
 * every chat before any starter is fetched. Within it threads sit where their
 * first prompt was sent, and a later reply never moves one: the order is the
 * channel's history, not its activity.
 */
export function buildChannelFeed(
  chats: readonly SidebarChatRow[],
  starters: Readonly<Record<string, ThreadStarter>>,
  limit: number
): ChannelFeed {
  const started = chats
    .filter((chat) => chat.lastMessageAt != null)
    .sort((left, right) => right._creationTime - left._creationTime)
  const windowChats = started.slice(0, limit)

  const threads: ChannelThread[] = []
  const wantedChatIds: string[] = []
  for (const chat of windowChats) {
    const starter = starters[chat.chatId]
    if (starter) threads.push({ chat, starter })
    else wantedChatIds.push(chat.chatId)
  }
  threads.sort((left, right) => left.starter.createdAt - right.starter.createdAt)

  const days: ChannelDay[] = []
  for (const thread of threads) {
    const startMs = startOfLocalDay(thread.starter.createdAt)
    const day = days[days.length - 1]
    if (day?.startMs === startMs) day.threads.push(thread)
    else days.push({ startMs, threads: [thread] })
  }

  return { days, wantedChatIds, hasMore: started.length > windowChats.length }
}

/** "Today", "Yesterday", then the date, with the year once it isn't this one. */
export function formatChannelDayLabel(dayStartMs: number, nowMs: number) {
  const todayStartMs = startOfLocalDay(nowMs)
  if (dayStartMs === todayStartMs) return "Today"
  // Rounded, so a 23- or 25-hour day across a clock change still counts as one.
  if (Math.round((todayStartMs - dayStartMs) / DAY_MS) === 1) return "Yesterday"
  const sameYear = new Date(dayStartMs).getFullYear() === new Date(nowMs).getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(dayStartMs)
}

/**
 * Everything in a chat after its first prompt is a reply to it: each turn's
 * answer, and each later prompt. Null when the chat's turns predate the
 * counter, where the row says nothing rather than claiming a number.
 */
export function getChannelReplyCount(chat: Pick<SidebarChatRow, "turnCount">) {
  if (!chat.turnCount) return null
  return chat.turnCount * 2 - 1
}
