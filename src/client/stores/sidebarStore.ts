import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import type { KannaStatus, SidebarChatRow, SidebarData } from "../../shared/types"
import { stabilizeSidebarData } from "../app/sidebarStability"
import { applySidebarProjectOrder } from "../app/kannaStateHelpers"
import { formatProjectRepoBranch } from "../lib/project-label"
import { prunePendingSends } from "./pendingSendStore"

/**
 * The sidebar snapshot, held outside the React tree.
 *
 * It used to live in `useKannaState`, which meant every sidebar push re-rendered
 * `KannaLayout` and therefore the whole app — the chat page, the command
 * palette, the transcript. But a running turn moves a sidebar field several
 * times a second (`lastAgentMessageAt`, the reply preview, `pendingToolKind`),
 * so that was the app's single largest source of wasted renders.
 *
 * Here, only components that select from it re-render, and only when the slice
 * they selected changed. Everything that needs a *derived scalar* off the
 * snapshot — "which project owns this chat", "what goes in the window title" —
 * selects that scalar rather than the snapshot, so it re-renders when the answer
 * changes rather than when any chat streams a token.
 *
 * Callers that need the snapshot inside an event handler should read
 * `useSidebarStore.getState()` instead of subscribing. That keeps the handler
 * identity stable, which is what lets the components holding it stay memoized.
 */

interface SidebarState {
  data: SidebarData
  ready: boolean
  /**
   * Drag-reorder applied locally until the server echoes it back. Cleared once
   * the pushed order matches, so a failed reorder snaps back rather than sticks.
   */
  optimisticProjectOrder: string[] | null
  setSnapshot: (snapshot: SidebarData) => void
  setOptimisticProjectOrder: (projectIds: string[] | null) => void
}

const EMPTY_SIDEBAR_DATA: SidebarData = { projectGroups: [] }

export const useSidebarStore = create<SidebarState>()((set) => ({
  data: EMPTY_SIDEBAR_DATA,
  ready: false,
  optimisticProjectOrder: null,

  setSnapshot: (snapshot) => set((state) => {
    // The snapshot is the moment we learn a send landed, so it is also where
    // the in-flight bookkeeping gets cleaned up.
    prunePendingSends(snapshot.projectGroups)

    // Stabilize against what we already hold before applying the local order,
    // so an unchanged group keeps its identity through both steps.
    const stabilized = stabilizeSidebarData(state.data, snapshot)
    const ordered = applyOptimisticOrder(stabilized, state.optimisticProjectOrder)
    const orderSettled = state.optimisticProjectOrder !== null
      && applySidebarProjectOrder(stabilized.projectGroups, state.optimisticProjectOrder)
        === stabilized.projectGroups

    return {
      data: ordered === state.data ? state.data : ordered,
      ready: true,
      optimisticProjectOrder: orderSettled ? null : state.optimisticProjectOrder,
    }
  }),

  setOptimisticProjectOrder: (projectIds) => set((state) => ({
    optimisticProjectOrder: projectIds,
    data: applyOptimisticOrder(state.data, projectIds),
  })),
}))

function applyOptimisticOrder(data: SidebarData, order: string[] | null): SidebarData {
  const projectGroups = applySidebarProjectOrder(data.projectGroups, order)
  return projectGroups === data.projectGroups ? data : { ...data, projectGroups }
}

/** The whole snapshot. Only the sidebar itself and the open palette want this. */
export function useSidebarData(): SidebarData {
  return useSidebarStore((state) => state.data)
}

export function useSidebarReady(): boolean {
  return useSidebarStore((state) => state.ready)
}

/**
 * Which project a chat belongs to, without subscribing to the snapshot. Returns
 * null for an unknown chat so the caller can fall back to its own selection.
 */
export function useProjectIdForChat(chatId: string | null): string | null {
  return useSidebarStore((state) => {
    if (!chatId) return null
    for (const group of state.data.projectGroups) {
      if (group.chats.some((chat) => chat.chatId === chatId)) return group.groupKey
      if ((group.archivedChats ?? []).some((chat) => chat.chatId === chatId)) return group.groupKey
    }
    return null
  })
}

/**
 * The chat whose agent this chat reports to, or null for a chat of the user's
 * own. Read live rather than from how the chat began: the link can be moved
 * to another chat after the fact. A string, so a subscriber hears about a
 * change of parent and nothing else in the snapshot.
 */
export function useParentChatId(chatId: string | null): string | null {
  return useSidebarStore((state) => parentChatIdOf(state.data, chatId))
}

/** `useParentChatId` on a snapshot. An archived sub-chat still has its parent. */
export function parentChatIdOf(data: SidebarData, chatId: string | null): string | null {
  if (!chatId) return null
  for (const group of data.projectGroups) {
    const chat = group.chats.find((candidate) => candidate.chatId === chatId)
      ?? group.archivedChats?.find((candidate) => candidate.chatId === chatId)
    if (chat) return chat.parentChatId ?? null
  }
  return null
}

export function useProjectRepoUrl(projectId: string | null): string | undefined {
  return useSidebarStore((state) => (
    projectId
      ? state.data.projectGroups.find((group) => group.groupKey === projectId)?.repoUrl
      : undefined
  ))
}

/**
 * Does a chat exist in the snapshot at all? Archived counts — viewing an
 * archived chat is ordinary navigation, so only a deleted chat is "gone".
 */
export function useChatExists(chatId: string | null): boolean {
  return useSidebarStore((state) => {
    if (!chatId) return false
    return state.data.projectGroups.some((group) =>
      group.chats.some((chat) => chat.chatId === chatId)
      || (group.archivedChats ?? []).some((chat) => chat.chatId === chatId))
  })
}

/**
 * The chat's status as the sidebar last heard it. The sidebar is subscribed from
 * app start, so this is known the moment a chat opens, well before that chat's
 * own snapshot arrives.
 */
export function useSidebarChatStatus(chatId: string | null): KannaStatus | null {
  return useSidebarStore((state) => {
    if (!chatId) return null
    for (const group of state.data.projectGroups) {
      const chat = group.chats.find((row) => row.chatId === chatId)
        ?? (group.archivedChats ?? []).find((row) => row.chatId === chatId)
      if (chat) return chat.status
    }
    return null
  })
}

/**
 * Whether the sidebar has heard of a message in the chat. Known before the
 * chat's own snapshot arrives, like the status above; false for an unknown
 * chat.
 */
export function useSidebarChatHasMessages(chatId: string | null): boolean {
  return useSidebarStore((state) => {
    if (!chatId) return false
    for (const group of state.data.projectGroups) {
      const chat = group.chats.find((row) => row.chatId === chatId)
        ?? (group.archivedChats ?? []).find((row) => row.chatId === chatId)
      if (chat) return chat.lastMessageAt != null
    }
    return false
  })
}

/** The lead project group's identity — the app's fallback when nothing is open. */
export function useFirstProjectGroup() {
  return useSidebarStore(useShallow((state) => ({
    groupKey: state.data.projectGroups[0]?.groupKey ?? null,
    localPath: state.data.projectGroups[0]?.localPath ?? null,
  })))
}

/**
 * `repo/branch` for the project the composer is pointing at, resolved the way
 * the sidebar resolves it: by id first, falling back to the path when no chat
 * is open. A string, so the layout re-renders on a branch change and on nothing
 * else.
 */
export function useNavbarRepoLabel(projectId: string | null, localPath: string | undefined): string | null {
  return useSidebarStore((state) => {
    const groups = state.data.projectGroups
    const group = groups.find((item) => item.groupKey === projectId)
      ?? groups.find((item) => item.localPath === localPath)
    return group ? formatProjectRepoBranch(group) : null
  })
}

/** Every chat row in the snapshot — for lookups inside event handlers. */
export function findSidebarChat(chatId: string): SidebarChatRow | null {
  for (const group of useSidebarStore.getState().data.projectGroups) {
    const chat = group.chats.find((row) => row.chatId === chatId)
    if (chat) return chat
  }
  return null
}

/** The snapshot as it stands, for handlers that must not subscribe to it. */
export function getSidebarProjectGroups(): SidebarData["projectGroups"] {
  return useSidebarStore.getState().data.projectGroups
}
