import { memo, useMemo, useState } from "react"
import { Hash, Loader2, Pin, PinOff } from "lucide-react"
import type { SidebarProjectGroup } from "../../../shared/types"
import { computeChannelSections } from "../../lib/channel-sections"
import { cn } from "../../lib/utils"
import { useChannelPinStore } from "../../stores/channelPinStore"
import { useDraftStartTimes } from "../../stores/chatInputStore"
import { usePendingSendTimes } from "../../stores/pendingSendStore"
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
 * A project as a channel: its mark, its name, and a count of the threads
 * waiting on you. The mark is the hash, or a spinner while an agent is working
 * in any of its chats, so the name never shifts. Bold means something in it is
 * unread, as a Slack channel's is.
 */
const ChannelRow = memo(function ChannelRow({ group, active, pinned, onSelect, onTogglePin }: ChannelRowProps) {
  const unread = group.chats.some((chat) => chat.unread)
  const waitingCount = group.chats.filter((chat) => chat.status === "waiting_for_user").length
  const working = group.chats.some((chat) => chat.status === "running" || chat.status === "starting")

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
          {/* The chat rows' own spinner (`renderChatStatusDot`), in the hash's 16px slot. */}
          <span className="flex size-4 shrink-0 items-center justify-center">
            {working
              ? <Loader2 className="size-3.5 animate-spin text-logo" />
              : <Hash className="size-4 opacity-70" />}
          </span>
          <span className="min-w-0 flex-1 truncate">{group.title}</span>
          {/* The blue a chat row's waiting dot uses. */}
          {waitingCount > 0 ? (
            <span className="flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-blue-400 px-1 text-[11px] font-bold leading-none text-white">
              {waitingCount}
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
