import type { SidebarProjectGroup } from "../../shared/types"
import {
  computeSidebarThreadSections,
  flattenSidebarThreads,
  listedThreads,
  mergeRelevantThreads,
  type DraftStartTimes,
  type PendingSendTimes,
  type SidebarThread,
} from "./thread-sections"

/**
 * The Channels sidebar's sections: the Chats view's own sections, holding
 * projects instead of chats. React-free for tests.
 */

export interface ChannelSection {
  /** The chat section's key: "pinned", "in-progress", "relevant", a date bucket's, or "quiet". */
  key: string
  label: string
  /** In Progress has no toggle, as in the Chats view. */
  collapsible: boolean
  defaultExpanded: boolean
  groups: SidebarProjectGroup[]
}

/** Project id → when the channel was pinned. */
export type ChannelPins = Readonly<Record<string, number>>

/**
 * Each project goes to the section of its highest-priority chat: the sections
 * are walked in display order, and a project lands where it is first met. So
 * one with a chat from yesterday and one from last week sits under Yesterday,
 * and one with a chat from today and a relevant one sits under Relevant.
 * Within a section projects keep the order of the chats that put them there.
 *
 * Pinned holds the channels pinned in their own right and nothing else. A
 * pinned chat is not a pinned project: its pin is set aside here, and the chat
 * counts toward its project by status and age like any other.
 *
 * Projects with no chat in any section (none yet, or all archived) trail in a
 * section of their own, folded: a channel list has to keep them reachable,
 * which the Chats view has no need to.
 */
export function computeChannelSections(
  projectGroups: readonly SidebarProjectGroup[],
  nowMs: number,
  channelPins: ChannelPins,
  draftStartTimes?: DraftStartTimes,
  pendingSends?: PendingSendTimes,
): ChannelSection[] {
  const threads = listedThreads(flattenSidebarThreads({ projectGroups: [...projectGroups] })).map((thread) => (
    thread.row.pinnedAt == null ? thread : { ...thread, row: { ...thread.row, pinnedAt: undefined } }
  ))
  const sections = computeSidebarThreadSections(threads, nowMs, draftStartTimes, pendingSends)
  // Review folded into Relevant, as the Chats view shows it.
  const relevant = mergeRelevantThreads(sections, draftStartTimes)

  const groupsById = new Map(projectGroups.map((group) => [group.groupKey, group]))
  const placed = new Set<string>()

  const take = (projectIds: Iterable<string>) => {
    const groups: SidebarProjectGroup[] = []
    for (const projectId of projectIds) {
      const group = groupsById.get(projectId)
      if (!group || placed.has(projectId)) continue
      placed.add(projectId)
      groups.push(group)
    }
    return groups
  }
  const projectIdsOf = (threads: readonly SidebarThread[]) => threads.map((thread) => thread.projectId)

  const pinnedChannelIds = Object.keys(channelPins)
    .sort((left, right) => channelPins[left]! - channelPins[right]! || left.localeCompare(right))

  const result: ChannelSection[] = [
    {
      key: "pinned",
      label: "Pinned",
      collapsible: true,
      defaultExpanded: true,
      groups: take(pinnedChannelIds),
    },
    {
      key: "in-progress",
      label: "In Progress",
      collapsible: false,
      defaultExpanded: true,
      groups: take(projectIdsOf(sections.inProgress)),
    },
    {
      key: "relevant",
      label: "Relevant",
      collapsible: true,
      defaultExpanded: true,
      groups: take(projectIdsOf(relevant)),
    },
    ...sections.buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      collapsible: true,
      defaultExpanded: bucket.defaultExpanded,
      groups: take(projectIdsOf(bucket.threads)),
    })),
    {
      key: "quiet",
      label: "No Recent Chats",
      collapsible: true,
      defaultExpanded: false,
      groups: take(projectGroups.map((group) => group.groupKey)),
    },
  ]
  return result.filter((section) => section.groups.length > 0)
}

export interface ChannelPeekGroup {
  key: string
  label: string
  threads: SidebarThread[]
}

/**
 * The chats a channel's hover card offers: the ones you are most likely
 * hovering it to reach. That is everything in the Chats view's sections down
 * to Relevant (In Progress, Relevant, Pinned, in that order here), and then
 * one group further:
 * the project's most recent date bucket. A project with nothing pressing
 * therefore shows just its latest day of chats.
 *
 * `all` is the card asked for the rest: every date bucket, in order.
 */
export function getChannelPeekGroups(
  group: SidebarProjectGroup,
  nowMs: number,
  draftStartTimes?: DraftStartTimes,
  pendingSends?: PendingSendTimes,
  all = false,
): ChannelPeekGroup[] {
  const threads = listedThreads(flattenSidebarThreads({ projectGroups: [group] }))
  const sections = computeSidebarThreadSections(threads, nowMs, draftStartTimes, pendingSends)
  const buckets = all ? sections.buckets : sections.buckets.slice(0, 1)
  return [
    // Pinned comes last of the three here, unlike the Chats view: the card
    // leads with what is happening and what wants you now. This is the one
    // place a channel's pinned chats show; the sidebar's Pinned section is
    // for pinned channels only.
    { key: "in-progress", label: "In Progress", threads: sections.inProgress },
    { key: "relevant", label: "Relevant", threads: mergeRelevantThreads(sections, draftStartTimes) },
    { key: "pinned", label: "Pinned", threads: sections.pinned },
    ...buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
  ].filter((peekGroup) => peekGroup.threads.length > 0)
}
