import { memo, useCallback, useMemo, useRef, useState, type ReactNode, type RefObject } from "react"
import { ChevronDown, Hash, SquarePen } from "lucide-react"
import type { SidebarProjectGroup } from "../../../shared/types"
import { computeChannelSections, getChannelPeekGroups, type ChannelPeekGroup } from "../../lib/channel-sections"
import { useHasFinePointer } from "../../lib/pointer"
import { getThreadDetailLabel } from "../../lib/thread-detail-label"
import type { SidebarThread } from "../../lib/thread-sections"
import { getPathBasename } from "../../lib/formatters"
import { cn, normalizeChatId } from "../../lib/utils"
import { useChannelPinStore } from "../../stores/channelPinStore"
import { useDraftStartTimes } from "../../stores/chatInputStore"
import { usePendingSendTimes } from "../../stores/pendingSendStore"
import { useSectionOverrides } from "../../stores/sidebarSectionStore"
import { renderChatStatusDot, ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { ProjectSectionMenu } from "../chat-ui/sidebar/Menus"
import { SectionHeader } from "../chat-ui/sidebar/ThreadSections"
import { LIST_HOVER_CARD_ROOM_BELOW, ListHoverCard } from "../ui/list-hover-card"

/** What a channel row carries its project id in, for the list's hover card. */
const CHANNEL_ROW_ATTRIBUTE = "data-channel-id"

/**
 * The sidebar's chat hover card, for the chats listed inside a channel's
 * card. Handed in rather than built here: it takes everything the sidebar's
 * own takes (previews, touched files, jump targets), and the sidebar already
 * holds all of it.
 */
export type RenderChatHoverCard = (
  containerRef: RefObject<HTMLDivElement | null>,
  threads: SidebarThread[],
) => ReactNode

/**
 * What a channel's hover card holds: the chats you would open the channel to
 * get to (`getChannelPeekGroups`), each a click away from here instead.
 */
function ChannelPeek({
  peekGroups,
  activeChatId,
  nowMs,
  onSelectChat,
  onNewChat,
  onShowMore,
  renderChatHoverCard,
}: {
  /** Empty for a channel with no chats yet: the card is then New Chat alone. */
  peekGroups: ChannelPeekGroup[]
  activeChatId: string | null
  nowMs: number
  onSelectChat: (chatId: string) => void
  onNewChat: () => void
  /** Present while the channel has chats the card is not showing. */
  onShowMore?: () => void
  renderChatHoverCard: RenderChatHoverCard
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const peekThreads = useMemo(() => peekGroups.flatMap((peekGroup) => peekGroup.threads), [peekGroups])

  return (
    <>
      {/* Heads the card and stays there: it is level with the channel, the
          first thing under the pointer coming across, and it doesn't scroll
          away with the list. */}
      <button type="button" onClick={onNewChat} className="group/peek block w-full py-px text-left">
        <span className="flex w-full items-center gap-2.5 rounded-lg border border-border/0 px-2 py-1.5 text-sm text-muted-foreground transition-colors group-hover/peek:border-border group-hover/peek:bg-muted group-hover/peek:text-foreground">
          <SquarePen className="size-4 shrink-0" />
          <span>New Chat</span>
        </span>
      </button>
      {/* Edge to edge, through the card's 4px padding. 3px either side plus
          the rows' own pixel is that same 4px. */}
      {peekGroups.length > 0 ? <div className="-mx-1 my-[3px] h-px bg-border" /> : null}
      {/* A long list runs from under New Chat to the bottom of the window,
          and scrolls there. Near the foot of the sidebar that would leave it
          a sliver, so it never gets less than 280px, and the card rises
          above its channel to find them (see `LIST_HOVER_CARD_ROOM_BELOW`).
          The 51px is everything else in the card: its vertical padding and
          border (8px), New Chat (36px) and the divider (7px).

          Scrolls here rather than on the card, which must not clip the
          bridge it lays over the gap to the row. */}
      <div
        ref={listRef}
        className="overflow-y-auto overscroll-contain"
        style={{ maxHeight: `max(280px, calc(var(${LIST_HOVER_CARD_ROOM_BELOW}) - 51px))` }}
      >
        {peekGroups.map((peekGroup, index) => (
          <div key={peekGroup.key}>
            {/* The first group goes unnamed: the divider above it has already
                said where the chats start. */}
            {index === 0 ? null : (
              <div className="px-1.5 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{peekGroup.label}</div>
            )}
            {peekGroup.threads.map((thread) => (
              <button
                key={thread.chatId}
                type="button"
                // What the chat hover card finds the row under the pointer by.
                data-chat-id={normalizeChatId(thread.chatId)}
                onClick={() => onSelectChat(thread.chatId)}
                // The button is the hover target and the box inside it is
                // what highlights, as with the channel rows: buttons touch,
                // and the 2px between boxes is a pixel of padding on each.
                className="group/peek block w-full py-px text-left"
              >
                <span
                  className={cn(
                    // The channel rows' own box, hover and selection
                    // (`ChannelRow`): the card is the sidebar's submenu, and
                    // the list it hangs off is the one it should match.
                    "flex w-full items-center gap-2.5 rounded-lg border px-2 py-1.5 text-sm transition-colors",
                    normalizeChatId(thread.chatId) === activeChatId
                      ? "border-border bg-muted"
                      : "border-border/0 group-hover/peek:border-border group-hover/peek:bg-muted"
                  )}
                >
                  <ThreadRowContent
                    thread={thread}
                    showStatus
                    dimIdleTitles={false}
                    detailLabel={getThreadDetailLabel(thread, "project-scoped", nowMs)}
                  />
                </span>
              </button>
            ))}
          </div>
        ))}
        {/* A row like the others, so it sits in their rhythm and takes their
            hover. Clicking the channel does the same thing. */}
        {onShowMore ? (
          <button type="button" onClick={onShowMore} className="group/peek block w-full py-px text-left">
            <span className="flex w-full items-center gap-2.5 rounded-lg border border-border/0 px-2 py-1.5 text-sm text-muted-foreground transition-colors group-hover/peek:border-border group-hover/peek:bg-muted">
              <ChevronDown className="size-4 shrink-0" />
              <span>Show more</span>
            </span>
          </button>
        ) : null}
      </div>
      {/* Each chat's own card, beside this one. Rendered from inside this
          card on purpose; see `ListHoverCard` on nesting. */}
      {renderChatHoverCard(listRef, peekThreads)}
    </>
  )
}

/** What a channel's right-click menu does: the project menu's actions, by project. */
export interface ChannelActions {
  editorLabel: string
  onCreateChat: (projectId: string) => void
  onRenameProject: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onCopyPath: (localPath: string) => void
  onOpenExternalPath: (action: "open_finder" | "open_editor", localPath: string) => void
  onShowArchivedProject: (projectId: string) => void
  onHideProject: (projectId: string) => void
}

interface ChannelRowProps {
  group: SidebarProjectGroup
  active: boolean
  /** Its menu is pinned open. Drawn as the hover it is holding. */
  menuPinned: boolean
  pinned: boolean
  actions: ChannelActions
  onSelect: (projectId: string) => void
  onTogglePin: (projectId: string) => void
}

/**
 * A project as a channel: its mark, its name, and a count of the chats that
 * want you (unread, or waiting on an answer). The mark is the hash while every
 * chat in it is idle and read, and otherwise the status glyph of its most
 * pressing chat, in the hash's slot so the name never shifts. Bold means
 * something in it is unread, as a Slack channel's is.
 *
 * The row has no hover card of its own: the list keeps one for all of them
 * and finds the row under the pointer by `CHANNEL_ROW_ATTRIBUTE`.
 */
const ChannelRow = memo(function ChannelRow({ group, active, menuPinned, pinned, actions, onSelect, onTogglePin }: ChannelRowProps) {
  const unread = group.chats.some((chat) => chat.unread)
  // Chats that want you: unread, or waiting on an answer. One chat counts
  // once even when it is both.
  const attentionCount = group.chats.filter((chat) => chat.unread || chat.status === "waiting_for_user").length
  // The mark is the status of the channel's most pressing chat, drawn as that
  // chat's own row draws it: running, then waiting on you, then unread.
  const leadChat = group.chats.find((chat) => chat.status === "running" || chat.status === "starting")
    ?? group.chats.find((chat) => chat.status === "waiting_for_user")
    ?? group.chats.find((chat) => chat.unread)
  const statusMark = leadChat ? renderChatStatusDot(leadChat) : null

  return (
    // The Projects view's own project menu (`ProjectSectionMenu`), plus Pin.
    <ProjectSectionMenu
      editorLabel={actions.editorLabel}
      repoUrl={group.repoUrl}
      pinned={pinned}
      onTogglePin={() => onTogglePin(group.groupKey)}
      onNewChat={() => actions.onCreateChat(group.groupKey)}
      onRename={() => actions.onRenameProject(group.groupKey, group.sidebarTitle, group.realTitle || getPathBasename(group.localPath))}
      onCopyPath={() => actions.onCopyPath(group.localPath)}
      onShowArchived={() => actions.onShowArchivedProject(group.groupKey)}
      onOpenInFinder={() => actions.onOpenExternalPath("open_finder", group.localPath)}
      onOpenInEditor={() => actions.onOpenExternalPath("open_editor", group.localPath)}
      onHide={() => actions.onHideProject(group.groupKey)}
    >
        <button
          type="button"
          {...{ [CHANNEL_ROW_ATTRIBUTE]: group.groupKey }}
          onClick={() => onSelect(group.groupKey)}
          aria-current={active ? "page" : undefined}
          aria-expanded={menuPinned}
          // The button is the hover target and the box inside it is what
          // highlights. Buttons touch, so the pointer passes from one channel
          // to the next without ever being over neither; the 2px between
          // boxes is a pixel of padding on each.
          className="group/channel block w-full py-px text-left"
        >
          <span
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-sm transition-colors max-md:py-2 max-md:text-base",
              active
                ? "border-border bg-muted text-foreground"
                : menuPinned
                  ? "border-border bg-muted"
                  : "border-border/0 group-hover/channel:border-border group-hover/channel:bg-muted",
              !active && (unread ? "text-foreground" : "text-muted-foreground"),
              unread && "font-semibold"
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {statusMark ?? <Hash className="size-4 opacity-70" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{group.title}</span>
            {/* Neutral: the mark on the left carries the colour. A tint of the
                text colour rather than `bg-muted`, which is the selected row's
                own background and would hide the badge there. */}
            {attentionCount > 0 ? (
              <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-foreground/10 px-1 text-[11px] font-bold leading-none text-foreground">
                {attentionCount}
              </span>
            ) : null}
          </span>
        </button>
    </ProjectSectionMenu>
  )
})

/**
 * The sidebar's Channels view: every project, and nothing under it (a
 * project's chats are in its channel), grouped into the Chats view's sections.
 * See `computeChannelSections` for which section a project lands in.
 */
export function ChannelList({
  projectGroups,
  activeProjectId,
  nowMs,
  activeChatId,
  onSelect,
  onSelectChat,
  renderChatHoverCard,
  actions,
}: {
  /** Must be stable (memoized): it reaches every memoized row. */
  actions: ChannelActions
  projectGroups: SidebarProjectGroup[]
  activeProjectId: string | null
  /** Anchor for the date buckets, as in the Chats view. */
  nowMs: number
  /** The open chat, highlighted in a channel's hover card. Normalized. */
  activeChatId: string | null
  /** Opens the channel itself. Touch only: with a pointer, a click opens up its card. */
  onSelect: (projectId: string) => void
  /** Opens a chat picked from a channel's hover card. */
  onSelectChat: (chatId: string) => void
  renderChatHoverCard: RenderChatHoverCard
}) {
  const listRef = useRef<HTMLDivElement>(null)
  // The channel whose menu is pinned open, showing all of its chats. A click
  // on the channel pins it (and a second unpins it), as does its menu's "Show
  // more"; a click elsewhere, Escape, or picking a chat lets it go. See
  // `ListHoverCard` on pinning.
  const [pinnedChannelId, setPinnedChannelId] = useState<string | null>(null)
  const unpinChannel = useCallback(() => setPinnedChannelId(null), [])
  const togglePinnedChannel = useCallback((projectId: string) => {
    setPinnedChannelId((current) => (current === projectId ? null : projectId))
  }, [])
  // Without hover there is no menu to pin, so a tap opens the channel itself
  // (`onSelect`): the only way to its chats on touch.
  const hasFinePointer = useHasFinePointer()
  const handleSelect = hasFinePointer ? togglePinnedChannel : onSelect
  const channelPins = useChannelPinStore((state) => state.pins)
  const togglePin = useChannelPinStore((state) => state.toggle)
  // Browser-local inputs to the sections; see `ThreadSections`.
  const draftStartTimes = useDraftStartTimes()
  const pendingSends = usePendingSendTimes()
  const sections = useMemo(
    () => computeChannelSections(projectGroups, nowMs, channelPins, draftStartTimes, pendingSends),
    [channelPins, draftStartTimes, nowMs, pendingSends, projectGroups]
  )
  // In a store, so the sections are as you left them when you come back from
  // a channel (which unmounts this list).
  const [expandOverrides, setSectionExpanded] = useSectionOverrides("channels")

  return (
    <div ref={listRef}>
      {sections.map((section) => {
        const isExpanded = !section.collapsible || (expandOverrides[section.key] ?? section.defaultExpanded)
        return (
          <div key={section.key}>
            <SectionHeader
              label={section.label}
              isExpanded={isExpanded}
              onToggle={section.collapsible ? () => setSectionExpanded(section.key, !isExpanded) : undefined}
            />
            {isExpanded ? (
              // No gap: the rows carry the Chats view's 2px spacing inside
              // themselves (see `ChannelRow`).
              <div className="mb-3 flex flex-col">
                {section.groups.map((group) => (
                  <ChannelRow
                    key={group.groupKey}
                    group={group}
                    active={group.groupKey === activeProjectId}
                    menuPinned={group.groupKey === pinnedChannelId}
                    pinned={channelPins[group.groupKey] != null}
                    actions={actions}
                    onSelect={handleSelect}
                    onTogglePin={togglePin}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
      {/* One card for every channel above, on whichever is under the pointer.
          Every channel has one: at the least it offers a new chat. */}
      <ListHoverCard
        containerRef={listRef}
        rowAttribute={CHANNEL_ROW_ATTRIBUTE}
        side="right"
        // Clicking a channel pins its menu; it must not also close it.
        keepOpenOnRowClick
        pinnedKey={pinnedChannelId}
        onUnpin={unpinChannel}
        // A submenu of the sidebar more than a card about a row, so it is
        // drawn as part of it: 2px off the sidebar's right edge (a row
        // ends 8px inside it, padding and border), and in the sidebar's
        // opaque background instead of the cards' translucent one.
        //
        // Raised so its first row, New Chat, is level with the channel,
        // center on center, then a pixel lower, where it reads as level.
        // The channel's center is 18px down its 36px row. New Chat's is
        // 22px down the card: 1px border, 3px padding, half its own 36px.
        sideOffset={10}
        alignOffset={-3}
        // 4px of padding on every side of the rows' boxes (3px above and
        // below, plus the pixel each row keeps for its spacing), and a corner
        // concentric with theirs: their 8px radius plus that 4px.
        className="rounded-[12px] bg-background px-1 py-[3px] backdrop-blur-none dark:bg-card"
      >
        {(projectId, dismiss) => {
          const group = projectGroups.find((item) => item.groupKey === projectId)
          if (!group) return null
          const allPeekGroups = getChannelPeekGroups(group, nowMs, draftStartTimes, pendingSends, true)
          const firstPeekGroups = getChannelPeekGroups(group, nowMs, draftStartTimes, pendingSends)
          // Pinned is opened up: the click that holds the menu is the one
          // that asked for the rest of it.
          const pinned = pinnedChannelId === projectId
          // "Show more" takes a row. Hiding a single chat behind it saves
          // nothing, so that chat is simply shown.
          const countChats = (peekGroups: ChannelPeekGroup[]) => (
            peekGroups.reduce((count, peekGroup) => count + peekGroup.threads.length, 0)
          )
          const hiddenCount = countChats(allPeekGroups) - countChats(firstPeekGroups)
          const showAll = pinned || hiddenCount <= 1
          return (
            <ChannelPeek
              peekGroups={showAll ? allPeekGroups : firstPeekGroups}
              onShowMore={showAll ? undefined : () => setPinnedChannelId(projectId)}
              activeChatId={activeChatId}
              nowMs={nowMs}
              onNewChat={() => {
                unpinChannel()
                dismiss()
                actions.onCreateChat(projectId)
              }}
              onSelectChat={(chatId) => {
                unpinChannel()
                dismiss()
                onSelectChat(chatId)
              }}
              renderChatHoverCard={renderChatHoverCard}
            />
          )
        }}
      </ListHoverCard>
    </div>
  )
}
