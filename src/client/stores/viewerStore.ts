import { create } from "zustand"
import type { ChartToolPayload, DisplayAttachment } from "../../shared/display-tools"
import type { ChatAttachment } from "../../shared/types"
import type { VisualizationArtifact } from "../../shared/visualization"
import type { ChatJumpTarget } from "../lib/chat-navigation"
import { generateUUID } from "../lib/utils"
import { settledChatViewer, useRightSidebarStore, type ChatViewerState } from "./rightSidebarStore"

/**
 * The one viewer: what the elevated card beside (or over) the chat is
 * showing, if anything. A changed file's diff, an attachment, a chart at
 * full size or a sub-chat all open here, so they share one surface, one
 * chrome and one set of keys, and nothing else in the app keeps a modal of
 * its own for them.
 *
 * Each chat has its own, kept with the rest of the page's pane layout in the
 * right sidebar store (`chatViewers`), which is what survives a chat switch
 * and a reload. This store only knows which chat the page is showing, so
 * the ones who open a file from deep in the transcript needn't.
 */

/** An attachment from anywhere (the composer, a prompt, an agent's send), in one shape. */
export interface ViewerAttachment {
  url: string
  name: string
  mimeType: string
  size: number | null
}

export type ViewerItem =
  | { kind: "diff"; projectId: string; path: string }
  /** A file in the project, as it is on disk: `path` relative to the project, `line` to jump to. */
  | { kind: "file"; projectId: string; path: string; line?: number }
  | { kind: "attachment"; attachment: ViewerAttachment }
  | { kind: "chart"; payload: ChartToolPayload }
  /** An inline visualization at full size. A second copy of the saved document, not the one in the transcript. */
  | { kind: "visualization"; artifact: VisualizationArtifact }
  /**
   * Another chat, live, with a composer of its own: any chat the one the
   * page is on refers to (see `lib/chat-open`). `back` is the chats that lead back from
   * it, oldest first, when it was reached by a click inside the previewer.
   *
   * `graph` is set on a chat opened from the graph (below): the chat the
   * graph was opened for. It is the start of that chat's trail, so Back from
   * it, or from the first chat on `back`, returns to the graph.
   */
  | { kind: "chat"; chatId: string; back?: string[]; graph?: string }
  /**
   * The tree of sub-chats `chatId` is in, drawn from its root (see
   * `app/ChatGraph`). Selecting a chat in it puts that chat in its place.
   */
  | { kind: "graph"; chatId: string }

/**
 * What a pane's dragged width belongs to. A review, a preview and a chat
 * each open at a width of their own, and a width you dragged holds while you
 * go between things of one class.
 */
export type ViewerWidthClass = "review" | "chat" | "preview"

export function viewerWidthClass(item: ViewerItem): ViewerWidthClass {
  if (item.kind === "diff") return "review"
  return isChatTrailItem(item) ? "chat" : "preview"
}

/**
 * A chat, or the graph chats are picked from: the previewer's own subject,
 * as against a file or image opened over it. The two share a width, so the
 * pane holds still while a graph turns into the chat picked from it.
 */
export function isChatTrailItem(item: ViewerItem): item is Extract<ViewerItem, { kind: "chat" | "graph" }> {
  return item.kind === "chat" || item.kind === "graph"
}

/** A message to land on in the previewed chat: the transcript's one-shot jump, kept here until it is spent. */
export interface ViewerChatJump {
  chatId: string
  target: ChatJumpTarget
  requestId: string
}

/** The page with no chat yet has a viewer too, just not one worth keeping. */
function chatKeyOf(chatId: string | null) {
  return chatId ?? ""
}

interface ViewerState {
  /** Whose viewer is showing: the chat the page is on. */
  chatKey: string
  /**
   * Counts opens, so opening the same file again (a click on the Changes row
   * you already opened, after scrolling away from it) still jumps back to it.
   */
  openCount: number
  /**
   * How many previewers on the page can show a chat. Zero on a page that
   * mounts none, where opening a sub-chat has to navigate instead.
   */
  chatPreviewHosts: number
  /** Pending for the previewed chat; not kept across a reload, like any jump. */
  chatJump: ViewerChatJump | null
  /** The chat a mounted previewer holds a subscription on; see `usePreviewedChatId`. */
  liveChatId: string | null
  setChat: (chatId: string | null) => void
  /** `expanded` opens it over the chat whatever the pane was, and only for as long as it is open. */
  open: (item: ViewerItem, options?: { expanded?: boolean }) => void
  close: () => void
  closeAll: () => void
  setScrolledDiffPath: (path: string | null) => void
  toggleExpanded: () => void
  /** The width you dragged the pane to, kept for this chat. */
  setWidth: (widthPx: number) => void
  /** Called by a previewer that can show a chat, for as long as it is mounted. */
  registerChatPreviewHost: () => () => void
  setChatJump: (chatId: string, target: ChatJumpTarget) => void
  /** Called by the previewer's chat for as long as it is subscribed. */
  holdLiveChat: (chatId: string) => () => void
  clearChatJump: (requestId: string) => void
}

function currentViewer(chatKey: string) {
  return useRightSidebarStore.getState().chatViewers[chatKey] ?? null
}

function updateViewer(chatKey: string, update: (viewer: ChatViewerState) => ChatViewerState) {
  const viewer = currentViewer(chatKey)
  if (!viewer) return
  const next = update(viewer)
  if (next !== viewer) useRightSidebarStore.getState().setChatViewer(chatKey, next)
}

export const useViewerStore = create<ViewerState>()((set, get) => ({
  chatKey: "",
  openCount: 0,
  chatPreviewHosts: 0,
  chatJump: null,
  liveChatId: null,
  setChat: (chatId) => {
    const chatKey = chatKeyOf(chatId)
    const leaving = get().chatKey
    if (chatKey === leaving) return
    // The chat you're leaving reopens where its review had got to.
    updateViewer(leaving, settledChatViewer)
    set({ chatKey, chatJump: null })
  },
  open: (item, options) => {
    const { chatKey } = get()
    const current = currentViewer(chatKey)
    // The pane's own setting, under an item that opened expanded.
    const expanded = current ? current.expandedBefore ?? current.expanded : false
    // A dragged width holds while you look at things of one kind: a review,
    // a preview and a chat each open at their own width.
    const sameKind = current !== null && viewerWidthClass(current.item) === viewerWidthClass(item)
    // Something else opened over a chat preview keeps the way back to it,
    // through any number of files and images after it. Another chat doesn't:
    // that is the previewer moving on.
    const returnTo = isChatTrailItem(item) || !current
      ? undefined
      : isChatTrailItem(current.item)
        ? { item: current.item, ...(current.widthPx !== undefined ? { widthPx: current.widthPx } : {}) }
        : current.returnTo
    useRightSidebarStore.getState().setChatViewer(chatKey, {
      item,
      expanded: options?.expanded || expanded,
      ...(options?.expanded && !expanded ? { expandedBefore: false } : {}),
      ...(sameKind && current.widthPx !== undefined ? { widthPx: current.widthPx } : {}),
      ...(returnTo ? { returnTo } : {}),
    })
    set((state) => ({ openCount: state.openCount + 1 }))
  },
  close: () => {
    const { chatKey } = get()
    const current = currentViewer(chatKey)
    if (!current?.returnTo) {
      useRightSidebarStore.getState().setChatViewer(chatKey, null)
      return
    }
    const { item, widthPx } = current.returnTo
    useRightSidebarStore.getState().setChatViewer(chatKey, {
      item,
      expanded: current.expandedBefore ?? current.expanded,
      ...(widthPx !== undefined ? { widthPx } : {}),
    })
  },
  /** Shuts the pane whatever it would go back to: dragged shut, or the chat it previewed is gone. */
  closeAll: () => useRightSidebarStore.getState().setChatViewer(get().chatKey, null),
  setScrolledDiffPath: (path) => updateViewer(get().chatKey, (viewer) => (
    viewer.item.kind !== "diff" || (viewer.reviewPath ?? null) === path
      ? viewer
      : { ...viewer, reviewPath: path ?? undefined }
  )),
  toggleExpanded: () => updateViewer(get().chatKey, ({ expandedBefore: _, ...viewer }) => ({ ...viewer, expanded: !viewer.expanded })),
  setWidth: (widthPx) => updateViewer(get().chatKey, (viewer) => (
    viewer.widthPx === widthPx ? viewer : { ...viewer, widthPx }
  )),
  registerChatPreviewHost: () => {
    set((state) => ({ chatPreviewHosts: state.chatPreviewHosts + 1 }))
    return () => set((state) => ({ chatPreviewHosts: Math.max(0, state.chatPreviewHosts - 1) }))
  },
  holdLiveChat: (chatId) => {
    set({ liveChatId: chatId })
    return () => set((state) => (state.liveChatId === chatId ? { liveChatId: null } : state))
  },
  // generateUUID, not crypto.randomUUID: see `buildChatJumpLocationState`.
  setChatJump: (chatId, target) => set({ chatJump: { chatId, target, requestId: generateUUID() } }),
  clearChatJump: (requestId) => set((state) => (state.chatJump?.requestId === requestId ? { chatJump: null } : state)),
}))

export function openViewer(item: ViewerItem, options?: { expanded?: boolean }) {
  useViewerStore.getState().open(item, options)
}

/** What the page's chat has open in the viewer, and how, or null. */
export function useChatViewer(): ChatViewerState | null {
  const chatKey = useViewerStore((store) => store.chatKey)
  return useRightSidebarStore((store) => store.chatViewers[chatKey] ?? null)
}

/**
 * The chat the previewer is subscribed to right now, or null. Not what the
 * chat's viewer has stored: on a page that mounts no previewer nothing is
 * subscribed, whatever was left open.
 */
export function usePreviewedChatId(): string | null {
  return useViewerStore((store) => store.liveChatId)
}

/** The same, read once. */
export function getChatViewer(): ChatViewerState | null {
  return currentViewer(useViewerStore.getState().chatKey)
}

export function viewerAttachmentFromChat(attachment: ChatAttachment): ViewerAttachment {
  return { url: attachment.contentUrl, name: attachment.displayName, mimeType: attachment.mimeType, size: attachment.size }
}

export function viewerAttachmentFromDisplay(attachment: DisplayAttachment): ViewerAttachment {
  return { url: attachment.url, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size }
}

/**
 * The file the viewer's diff list is on, in this project, or null: the one
 * scrolled to, else the one opened. The Changes card lights it, so the two
 * move together.
 */
export function useReviewedPath(projectId: string | null) {
  const viewer = useChatViewer()
  return projectId && viewer?.item.kind === "diff" && viewer.item.projectId === projectId
    ? viewer.reviewPath ?? viewer.item.path
    : null
}
