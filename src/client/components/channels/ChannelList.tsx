import { memo, useMemo, useState } from "react"
import { Hash, Pin, PinOff } from "lucide-react"
import type { SidebarProjectGroup } from "../../../shared/types"
import { computeChannelSections } from "../../lib/channel-sections"
import { cn } from "../../lib/utils"
import { useChannelPinStore } from "../../stores/channelPinStore"
import { useDraftStartTimes } from "../../stores/chatInputStore"
import { usePendingSendTimes } from "../../stores/pendingSendStore"
import { renderChatStatusDot } from "../chat-ui/ThreadRowContent"
import { SectionHeader } from "../chat-ui/sidebar/ThreadSections"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"

interface ChannelRowProps {
  group: SidebarProjectGroup
  active: boolean
  pinned: boolean
  onSelect: (projectId: string) => void
  onTogglePin: (projectId: string) => void
}

/**
 * A project as a channel: its mark, its name, and a count of the chats that
 * want you (unread, or waiting on an answer). The mark is the hash while every chat in it is idle and
 * read, and otherwise the status glyph of its most pressing chat, in the
 * hash's slot so the name never shifts. Bold means something in it is unread,
 * as a Slack channel's is.
 */
const ChannelRow = memo(function ChannelRow({ group, active, pinned, onSelect, onTogglePin }: ChannelRowProps) {
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
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onSelect(group.groupKey)}
          aria-current={active ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left text-sm transition-colors max-md:py-2 max-md:text-base",
            active
              ? "border-border bg-muted text-foreground"
              : "border-border/0 hover:border-border hover:bg-muted",
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
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onTogglePin(group.groupKey)}>
          {pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
          <span className="text-xs font-medium">{pinned ? "Unpin" : "Pin"}</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
  onSelect,
}: {
  projectGroups: SidebarProjectGroup[]
  activeProjectId: string | null
  /** Anchor for the date buckets, as in the Chats view. */
  nowMs: number
  onSelect: (projectId: string) => void
}) {
  const channelPins = useChannelPinStore((state) => state.pins)
  const togglePin = useChannelPinStore((state) => state.toggle)
  // Browser-local inputs to the sections; see `ThreadSections`.
  const draftStartTimes = useDraftStartTimes()
  const pendingSends = usePendingSendTimes()
  const sections = useMemo(
    () => computeChannelSections(projectGroups, nowMs, channelPins, draftStartTimes, pendingSends),
    [channelPins, draftStartTimes, nowMs, pendingSends, projectGroups]
  )
  const [expandOverrides, setExpandOverrides] = useState<Record<string, boolean>>({})

  return (
    <div>
      {sections.map((section) => {
        const isExpanded = !section.collapsible || (expandOverrides[section.key] ?? section.defaultExpanded)
        return (
          <div key={section.key}>
            <SectionHeader
              label={section.label}
              isExpanded={isExpanded}
              onToggle={section.collapsible ? () => {
                setExpandOverrides((previous) => ({ ...previous, [section.key]: !isExpanded }))
              } : undefined}
            />
            {isExpanded ? (
              // The Chats view's own row spacing (`ThreadSections`).
              <div className="mb-3 space-y-[2px]">
                {section.groups.map((group) => (
                  <ChannelRow
                    key={group.groupKey}
                    group={group}
                    active={group.groupKey === activeProjectId}
                    pinned={channelPins[group.groupKey] != null}
                    onSelect={onSelect}
                    onTogglePin={togglePin}
                  />
                ))}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
