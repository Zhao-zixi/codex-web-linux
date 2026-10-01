import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react"
import { ArrowLeft, Hash, Loader2, PanelLeft, Paperclip } from "lucide-react"
import { useNavigate } from "react-router-dom"
import type { AgentProvider, ChatSkillsSnapshot, ProviderCatalogEntry, SidebarChatRow, ThreadStarter } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import type { SendOptions } from "../../app/useSendMessage"
import {
  buildChannelFeed,
  CHANNEL_PAGE_SIZE,
  formatChannelDayLabel,
  getChannelReplyCount,
  type ChannelDay,
} from "../../lib/channel-feed"
import { formatRelativeTime } from "../../lib/formatters"
import { formatProjectRepoBranch } from "../../lib/project-label"
import { CHANNEL_PANEL_WIDTH_STORAGE_KEY } from "../../lib/storageKeys"
import { cn, generateUUID, normalizeChatId } from "../../lib/utils"
import { useSidebarReady, useSidebarStore } from "../../stores/sidebarStore"
import { requestThreadStarters, useThreadStarterStore } from "../../stores/threadStarterStore"
import { ChatInput } from "../chat-ui/ChatInput"
import { MetaLabel, MetaRow } from "../messages/shared"
import { PROVIDER_BRAND_CLASSES, PROVIDER_ICONS } from "../provider-icons"
import { Button } from "../ui/button"

const DEFAULT_CHANNEL_WIDTH = 440
const MIN_CHANNEL_WIDTH = 320
/** What dragging the list wider always leaves for the thread beside it. */
const MIN_THREAD_WIDTH = 360
/** Scrolled this close to the oldest thread shown, the next page is asked for. */
const LOAD_OLDER_DISTANCE_PX = 400

const TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

/**
 * The feed's column: as wide as the transcript's (ChatTranscriptViewport) and
 * centered like it.
 */
const FEED_COLUMN = "mx-auto flex w-full max-w-[800px] gap-3"
/**
 * A message's card: the column plus 8px either side (a 1px border and 7px of
 * padding), so the text inside still starts on the column's edge. The border
 * and radius are a sidebar row's (`ThreadRow`), drawn only when the row is
 * hovered or its thread is open.
 */
const FEED_CARD = "mx-auto flex w-full max-w-[816px] gap-3 rounded-lg border border-border/0 p-[7px]"

/**
 * No ceiling of its own: like the transcript, the list goes as wide as you
 * drag it, and each item keeps to its column inside. `maxWidth` is the room
 * there is, when the caller knows it.
 */
function clampChannelWidth(width: number, maxWidth = Number.POSITIVE_INFINITY) {
  if (!Number.isFinite(width)) return DEFAULT_CHANNEL_WIDTH
  return Math.max(MIN_CHANNEL_WIDTH, Math.min(maxWidth, Math.round(width)))
}

function readStoredChannelWidth() {
  if (typeof window === "undefined") return DEFAULT_CHANNEL_WIDTH
  const stored = window.localStorage.getItem(CHANNEL_PANEL_WIDTH_STORAGE_KEY)
  return stored ? clampChannelWidth(Number(stored)) : DEFAULT_CHANNEL_WIDTH
}

function persistChannelWidth(width: number) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(CHANNEL_PANEL_WIDTH_STORAGE_KEY, String(width))
}

/** A message sent from here that the sidebar snapshot hasn't reported as a chat yet. */
interface PendingMessage {
  id: string
  /** Set once the server has made the chat. */
  chatId: string | null
  starter: ThreadStarter
}

/** The message itself: when, then what. Shared by a thread's row and one still being sent. */
function MessageBody({ starter }: { starter: ThreadStarter }) {
  return (
    <>
      <div className="flex items-baseline gap-2">
        <time className="text-xs text-muted-foreground" dateTime={new Date(starter.createdAt).toISOString()}>
          {TIME_FORMAT.format(starter.createdAt)}
        </time>
      </div>
      {/* Clamped: a prompt can be pages long, and the thread has all of it. */}
      <p className="line-clamp-[10] whitespace-pre-wrap break-words text-[15px] leading-[22px]">
        {starter.content}
        {starter.truncated ? "…" : null}
      </p>
      {starter.attachmentCount ? (
        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
          <Paperclip className="size-3" />
          <span>{starter.attachmentCount === 1 ? "1 attachment" : `${starter.attachmentCount} attachments`}</span>
        </div>
      ) : null}
    </>
  )
}

/** What the reply bar says after the count: the chat's state, or how old its last reply is. */
// "Waiting for you" is the blue of the sidebar's waiting badge (blue-400), one
// step darker in light mode, where that blue is too pale for text on white.
function getReplyDetail(chat: SidebarChatRow): { text: string; className?: string } | null {
  if (chat.status === "running" || chat.status === "starting") return { text: "Working…" }
  if (chat.status === "waiting_for_user") return { text: "Waiting for you", className: "font-medium text-blue-500 dark:text-blue-400" }
  if (chat.status === "failed") return { text: "Failed", className: "font-medium text-destructive" }
  const lastReplyAt = chat.lastAgentMessageAt ?? chat.lastTurnEndedAt
  if (lastReplyAt == null) return null
  return { text: formatRelativeTime(new Date(lastReplyAt).toISOString()) }
}

/**
 * The line under a message that stands for its thread: who replied, how many
 * replies, and how it's going. It reads the same whether or not its row is
 * hovered or open; the row's own background says that.
 */
function ReplyBar({ chat }: { chat: SidebarChatRow }) {
  const ProviderIcon = chat.provider ? PROVIDER_ICONS[chat.provider] : null
  const replyCount = getChannelReplyCount(chat)
  const detail = getReplyDetail(chat)
  const working = chat.status === "running" || chat.status === "starting"

  return (
    <div className="mt-1 flex h-8 items-center gap-2 text-[13px]">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-[5px]",
          chat.provider ? PROVIDER_BRAND_CLASSES[chat.provider] : "bg-muted text-muted-foreground"
        )}
      >
        {working
          ? <Loader2 className="size-3 animate-spin" />
          : ProviderIcon ? <ProviderIcon className="size-3" /> : <Hash className="size-3" />}
      </span>
      {/* Green is unread, as a chat row's unread dot is. */}
      <span className={cn("shrink-0 font-semibold", chat.unread ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
        {replyCount === null ? "Thread" : replyCount === 1 ? "1 reply" : `${replyCount} replies`}
      </span>
      {detail ? (
        <span className={cn("min-w-0 truncate text-muted-foreground", detail.className)}>{detail.text}</span>
      ) : null}
    </div>
  )
}

interface ThreadMessageProps {
  chat: SidebarChatRow
  starter: ThreadStarter
  open: boolean
  /** Unread by the row, but advancing it re-renders the row so its age stays current. */
  nowMs: number
  onOpen: (chatId: string) => void
}

/**
 * One thread, shown as its first message. The whole row opens the thread. A
 * div rather than a button, so its text can be selected and copied.
 */
const ThreadMessage = memo(function ThreadMessage({ chat, starter, open, onOpen }: ThreadMessageProps) {
  const handleClick = () => {
    // Finishing a text selection inside the row is not a click on it.
    if (window.getSelection()?.toString()) return
    onOpen(chat.chatId)
  }
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onOpen(chat.chatId)
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={open ? "true" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        // The row is the click target and the card inside it is what
        // highlights. Rows touch, so the pointer is never between two; the
        // 1px between cards is half a pixel of padding on each row.
        "group/thread cursor-pointer px-3 py-[0.5px] outline-none"
      )}
    >
      <div
        className={cn(
          FEED_CARD,
          // The sidebar's chat rows' own selected and hover treatment (`ThreadRow`).
          open
            ? "border-border bg-muted"
            : "border-border/0 group-hover/thread:border-border group-hover/thread:bg-muted/20 group-focus-visible/thread:border-border group-focus-visible/thread:bg-muted/20 dark:group-hover/thread:border-slate-400/10"
        )}
      >
        <div className="min-w-0 flex-1">
          <MessageBody starter={starter} />
          <ReplyBar chat={chat} />
        </div>
      </div>
    </div>
  )
})

/**
 * The transcript's own timestamp divider (`ResultMessage`): a hairline either
 * side of a quiet label, in the feed's column.
 */
function DayDivider({ label }: { label: string }) {
  return (
    <div className="px-5 py-3">
      <MetaRow className="mx-auto w-full max-w-[800px] px-0.5 text-xs tracking-wide">
        <div className="h-[1px] w-full bg-border/70" />
        <MetaLabel className="flex-shrink-0 whitespace-nowrap text-[12px] tracking-wide text-muted-foreground/60">{label}</MetaLabel>
        <div className="h-[1px] w-full bg-border/70" />
      </MetaRow>
    </div>
  )
}

function ChannelIntro({ title }: { title: string }) {
  return (
    <div className="px-5 pb-4 pt-10">
      <div className="mx-auto w-full max-w-[800px]">
      <div className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Hash className="size-6" />
      </div>
      <h2 className="mt-3 text-2xl font-bold leading-tight tracking-tight">{title}</h2>
      <p className="mt-1 max-w-[52ch] text-[15px] leading-[22px] text-muted-foreground">
        This is the start of {title}. Each message you send here starts a thread, and the agent replies inside it.
      </p>
      </div>
    </div>
  )
}

function FeedSkeleton() {
  return (
    <div className="animate-pulse space-y-5 px-5 py-4" aria-hidden>
      {["w-3/4", "w-1/2", "w-2/3"].map((width) => (
        <div key={width} className={FEED_COLUMN}>
          <div className="flex-1 space-y-2 pt-1">
            <div className="h-3 w-24 rounded bg-muted" />
            <div className={cn("h-3 rounded bg-muted", width)} />
          </div>
        </div>
      ))}
    </div>
  )
}

interface ChannelPanelProps {
  projectId: string
  /** The thread open beside the list, if any. */
  threadChatId: string | null
  socket: KannaSocket
  availableProviders: ProviderCatalogEntry[]
  sidebarCollapsed: boolean
  onExpandSidebar: () => void
  /** Starts a chat in the project with this message. Resolves to the chat's id. */
  onSend: (projectId: string, content: string, options?: SendOptions) => Promise<string>
}

/**
 * A project as a channel: its chats as a list of messages, each one a thread.
 *
 * It fills the page until a thread is open, then narrows to a column beside
 * it. On a phone the thread takes the page instead, so the list hides.
 */
export function ChannelPanel({
  projectId,
  threadChatId,
  socket,
  availableProviders,
  sidebarCollapsed,
  onExpandSidebar,
  onSend,
}: ChannelPanelProps) {
  const navigate = useNavigate()
  const sidebarReady = useSidebarReady()
  const group = useSidebarStore((state) => state.data.projectGroups.find((item) => item.groupKey === projectId))
  const starters = useThreadStarterStore((state) => state.starters)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [limit, setLimit] = useState(CHANNEL_PAGE_SIZE)
  const [pending, setPending] = useState<PendingMessage[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [width, setWidth] = useState(readStoredChannelWidth)
  const resizeStartRef = useRef<{ pointerX: number; width: number } | null>(null)
  const threadOpen = threadChatId !== null

  // A project that is gone (hidden, or a stale link) has no channel to show.
  useEffect(() => {
    if (sidebarReady && !group) navigate("/", { replace: true })
  }, [group, navigate, sidebarReady])

  useEffect(() => {
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(intervalId)
  }, [])

  const feed = useMemo(
    () => buildChannelFeed(group?.chats ?? [], starters, limit),
    [group?.chats, limit, starters]
  )
  // Without the chats the server has no prompt for: they will never have a
  // row, and waiting on them would hold the list at its loading state.
  const missing = useThreadStarterStore((state) => state.missing)
  const wantedChatIds = useMemo(
    () => feed.wantedChatIds.filter((chatId) => !missing[chatId]),
    [feed.wantedChatIds, missing]
  )

  const wantedKey = wantedChatIds.join(",")
  useEffect(() => {
    if (wantedKey) void requestThreadStarters(socket, wantedKey.split(","))
  }, [socket, wantedKey])

  // A sent message stays in the list as its own row until the snapshot brings
  // its chat, which then takes its place.
  const shownChatIds = useMemo(
    () => new Set(feed.days.flatMap((day) => day.threads.map((thread) => thread.chat.chatId))),
    [feed.days]
  )
  const visiblePending = pending.filter((message) => !message.chatId || !shownChatIds.has(message.chatId))
  useEffect(() => {
    setPending((current) => {
      const next = current.filter((message) => !message.chatId || !shownChatIds.has(message.chatId))
      return next.length === current.length ? current : next
    })
  }, [shownChatIds])

  // The list scrolls in a reversed column: its resting place is the newest
  // thread, and older ones loading in above leave what's on screen where it
  // is. Its scrollTop runs from 0 at the bottom to negative at the top.
  const loadOlderIfNearTop = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller || !feed.hasMore || wantedChatIds.length > 0) return
    const distanceFromTop = scroller.scrollHeight - scroller.clientHeight - Math.abs(scroller.scrollTop)
    if (distanceFromTop < LOAD_OLDER_DISTANCE_PX) setLimit((current) => current + CHANNEL_PAGE_SIZE)
  }, [feed.hasMore, wantedChatIds.length])

  // Also after each page lands: a page shorter than the list never scrolls.
  useLayoutEffect(() => {
    loadOlderIfNearTop()
  }, [loadOlderIfNearTop, feed.days])

  const openThread = useCallback((chatId: string) => {
    navigate(`/chat/${chatId}`)
  }, [navigate])

  const handleSubmit = useCallback(async (content: string, options?: SendOptions) => {
    const id = generateUUID()
    const starter: ThreadStarter = {
      content,
      createdAt: Date.now(),
      ...(options?.attachments?.length ? { attachmentCount: options.attachments.length } : {}),
    }
    setPending((current) => [...current, { id, chatId: null, starter }])
    scrollerRef.current?.scrollTo({ top: 0 })
    try {
      const chatId = await onSend(projectId, content, options)
      // The starter is known here, so the thread's row needs no fetch.
      useThreadStarterStore.getState().setStarter(chatId, starter)
      setPending((current) => current.map((message) => (message.id === id ? { ...message, chatId } : message)))
    } catch (error) {
      setPending((current) => current.filter((message) => message.id !== id))
      throw error
    }
  }, [onSend, projectId])

  const handleListSkills = useCallback(
    (provider: AgentProvider) => socket.command<ChatSkillsSnapshot>({ type: "chat.listSkills", provider, projectId }),
    [projectId, socket]
  )

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    resizeStartRef.current = { pointerX: event.clientX, width }
  }
  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeStartRef.current
    if (!start) return
    // Up to the page's right edge, less the thread's minimum.
    const section = event.currentTarget.parentElement
    const page = section?.parentElement
    const maxWidth = section && page
      ? page.getBoundingClientRect().right - section.getBoundingClientRect().left - MIN_THREAD_WIDTH
      : undefined
    setWidth(clampChannelWidth(start.width + event.clientX - start.pointerX, maxWidth))
  }
  const handleResizeEnd = () => {
    if (!resizeStartRef.current) return
    resizeStartRef.current = null
    persistChannelWidth(width)
  }

  const title = group?.title ?? ""
  const repoLabel = group ? formatProjectRepoBranch(group) : null
  const normalizedThreadChatId = threadChatId ? normalizeChatId(threadChatId) : null
  const days = withPendingDay(feed.days, visiblePending.length > 0, nowMs)
  const isLoadingFirstPage = !group || (feed.days.length === 0 && wantedChatIds.length > 0)
  const atChannelStart = !isLoadingFirstPage && !feed.hasMore && wantedChatIds.length === 0

  return (
    <section
      aria-label={title ? `${title} channel` : "Channel"}
      className={cn(
        "relative h-full min-h-0 min-w-0 flex-col bg-background",
        threadOpen
          ? // Shrinkable: a width dragged out on a wide window gives way on a
          // narrower one rather than pushing the thread off the page.
          "hidden md:flex md:w-[var(--channel-width)] md:min-w-[320px] md:border-r md:border-border"
          : "flex flex-1"
      )}
      style={{ "--channel-width": `${width}px` } as CSSProperties}
    >
      {/* No bar of its own: the sidebar names the channel. What a bar would
          have carried floats over the list's corner instead: the way back on
          a phone, and the sidebar's expand button while it is collapsed (the
          Mac app pins its own beside the traffic lights). */}
      <div className="absolute left-2 top-2 z-20 flex items-center">
        <Button
          variant="ghost"
          size="icon"
          className="size-10 rounded-full border border-border bg-background shadow-sm md:hidden"
          onClick={() => navigate("/")}
          title="Back"
        >
          <ArrowLeft className="size-5" />
        </Button>
        {sidebarCollapsed ? (
          <Button
            variant="ghost"
            size="icon"
            className="hidden rounded-lg border border-border bg-background shadow-sm md:flex mac-app:md:hidden"
            onClick={onExpandSidebar}
            title="Expand sidebar"
          >
            <PanelLeft className="size-4" />
          </Button>
        ) : null}
      </div>

      <div
        ref={scrollerRef}
        onScroll={loadOlderIfNearTop}
        className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto overflow-x-hidden"
      >
        <div className="pb-1">
          {isLoadingFirstPage ? <FeedSkeleton /> : null}
          {atChannelStart ? <ChannelIntro title={title} /> : null}
          {!isLoadingFirstPage && !atChannelStart ? (
            <div className="flex justify-center py-3 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : null}
          {days.map((day, index) => (
            <div key={day.startMs}>
              <DayDivider label={formatChannelDayLabel(day.startMs, nowMs)} />
              {day.threads.map((thread) => (
                <ThreadMessage
                  key={thread.chat.chatId}
                  chat={thread.chat}
                  starter={thread.starter}
                  open={normalizedThreadChatId === normalizeChatId(thread.chat.chatId)}
                  nowMs={nowMs}
                  onOpen={openThread}
                />
              ))}
              {index === days.length - 1 ? visiblePending.map((message) => (
                <div key={message.id} className="px-3 py-[0.5px]">
                  <div className={FEED_CARD}>
                    <div className="min-w-0 flex-1">
                      <MessageBody starter={message.starter} />
                    </div>
                  </div>
                </div>
              )) : null}
            </div>
          ))}
        </div>
      </div>

      {group ? (
        // No padding of its own: the composer brings its 12px gutter.
        <div className="shrink-0">
          <ChatInput
            // Per project: a draft typed to one channel is not sent to another.
            key={projectId}
            onSubmit={handleSubmit}
            disabled={false}
            chatId={null}
            projectId={projectId}
            projectPath={group.localPath}
            projectRepoLabel={repoLabel}
            activeProvider={null}
            availableProviders={availableProviders}
            onListSkills={handleListSkills}
          />
        </div>
      ) : null}

      {threadOpen ? (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize thread list"
          title="Resize thread list"
          className="absolute -right-1 bottom-0 top-0 z-30 hidden w-2 cursor-col-resize touch-none md:block"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => {
            setWidth(DEFAULT_CHANNEL_WIDTH)
            persistChannelWidth(DEFAULT_CHANNEL_WIDTH)
          }}
        />
      ) : null}
    </section>
  )
}

/** A message being sent belongs under today's divider, which an older channel doesn't have yet. */
function withPendingDay(days: ChannelDay[], hasPending: boolean, nowMs: number): ChannelDay[] {
  if (!hasPending) return days
  const today = new Date(nowMs)
  today.setHours(0, 0, 0, 0)
  if (days[days.length - 1]?.startMs === today.getTime()) return days
  return [...days, { startMs: today.getTime(), threads: [] }]
}
