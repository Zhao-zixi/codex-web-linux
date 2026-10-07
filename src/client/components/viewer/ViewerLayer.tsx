import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState, type Ref } from "react"
import { PANE_CLOSE_MS, prefersReducedMotion } from "../../app/paneAnimation"
import type { ChatViewerState } from "../../stores/rightSidebarStore"
import { isChatTrailItem, useChatViewer, useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import type { DiffViewerContext } from "../chat-ui/git/DiffViewer"
import type { ChatPreviewContext } from "../../app/ChatPage/ChatPreview"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../messages/shared"
import { cn } from "../../lib/utils"
import { ViewerPlacementProvider, type ViewerPlacement } from "./ViewerSurface"

// Each view loads with its first use: the diff renderer (shiki grammars),
// recharts and the markdown/table views are none of them first paint.
const DiffViewer = lazy(() => import("../chat-ui/git/DiffViewer").then((m) => ({ default: m.DiffViewer })))
const AttachmentViewer = lazy(() => import("./AttachmentViewer").then((m) => ({ default: m.AttachmentViewer })))
const ChartFullView = lazy(() => import("../messages/ChartTool").then((m) => ({ default: m.ChartFullView })))
const VisualizationFullView = lazy(() => import("../messages/Visualization").then((m) => ({ default: m.VisualizationFullView })))
const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))
// Its parts are the chat page's own, already loaded there. Lazy all the same:
// the export viewer mounts this layer too, and never shows a chat.
const ChatPreview = lazy(() => import("../../app/ChatPage/ChatPreview").then((m) => ({ default: m.ChatPreview })))
// React Flow comes with it, and only a page that can preview a chat shows one.
const GraphViewer = lazy(() => import("../../app/ChatGraph/GraphViewer").then((m) => ({ default: m.GraphViewer })))

/**
 * Whether the viewer has something to show on a page that knows this project
 * (null: no project, so no diffs or project files). A diff or file of another
 * project shows nothing, and the page shouldn't make room for it.
 */
function showsOn(item: ViewerItem | null, projectId: string | null | undefined) {
  if (!item) return false
  if (item.kind === "diff" || item.kind === "file") return Boolean(projectId) && item.projectId === projectId
  return true
}

/**
 * Where the viewer shows, and the one place it's mounted per page: the chat
 * page puts it in a pane beside the chat, or over the chat (navbar,
 * transcript, composer, terminal) when expanded or on a phone; the export
 * viewer over the whole page. It covers what it's placed in with the page
 * background, so nothing behind shows through, and sets the card 8px in, the
 * widget column's gutter.
 *
 * `diff` is what the page knows about the working tree; a page without one
 * (the export viewer) never opens a diff or a project file. `onOpenLocalLink`
 * handles a file link inside what's shown (a markdown preview's), as the
 * transcript's do. `placement` is given where the page has a pane for it.
 * `chat` is what the page knows about talking to a chat; a page without it
 * never previews one, and a chat clicked there is navigated to.
 */
export function ViewerLayer({ diff, chat, className, onOpenLocalLink, placement, presented, layerRef }: {
  diff?: DiffViewerContext
  chat?: ChatPreviewContext
  className?: string
  onOpenLocalLink?: (target: OpenLocalLinkTarget) => void
  placement?: ViewerPlacement
  /** What to show, from usePresentedViewer, on a page that animates it out; else what the chat has open. */
  presented?: PresentedViewer
  layerRef?: Ref<HTMLDivElement>
}) {
  const live = useChatViewer()
  const item = (presented ? presented.viewer : live)?.item ?? null
  const exiting = presented?.exiting ?? false
  const close = useViewerStore((store) => store.close)
  const openCount = useViewerStore((store) => store.openCount)
  // Counted while mounted, shown or not: it is what tells `useOpenChat` that
  // a chat clicked on this page has a previewer to open in.
  const canShowChat = Boolean(chat)
  useEffect(() => (canShowChat ? useViewerStore.getState().registerChatPreviewHost() : undefined), [canShowChat])
  if (!item || !showsOn(item, diff?.projectId) || (isChatTrailItem(item) && !chat)) return null
  // In a pane, the pane closes around it. Over the chat it leaves the way it
  // came, faded and a touch small, quicker than it came.
  const overlayExit = exiting && !(placement && !placement.expanded)

  return (
    <div
      ref={layerRef}
      inert={exiting || undefined}
      className={cn(
        "absolute inset-0 z-30 bg-background p-2",
        overlayExit && "opacity-0 transition-opacity duration-150 ease-snappy motion-safe:[&_[data-viewer-surface]]:scale-[0.98]",
        className,
      )}
    >
      <ViewerPlacementProvider value={placement ?? null}>
      <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
        <Suspense fallback={null}>
          {item.kind === "diff" && diff ? (
            <DiffViewer
              projectId={item.projectId}
              path={item.path}
              openCount={openCount}
              context={diff}
              onClose={close}
            />
          ) : item.kind === "attachment" ? (
            <AttachmentViewer attachment={item.attachment} onClose={close} />
          ) : item.kind === "file" && diff ? (
            // Keyed so a new file or line starts over: its own view, its own jump.
            <FileViewer key={`${item.path}:${item.line ?? ""}`} projectId={item.projectId} path={item.path} line={item.line} context={diff} onClose={close} />
          ) : item.kind === "chart" ? (
            <ChartFullView payload={item.payload} onClose={close} />
          ) : item.kind === "visualization" ? (
            <VisualizationFullView key={item.artifact.url} artifact={item.artifact} onClose={close} />
          ) : (item.kind === "graph" || (item.kind === "chat" && item.graph)) && chat ? (
            // The graph, and a chat picked from it: one view for both, so the
            // graph stays where it was under the chat and Back finds it there.
            <GraphViewer item={item} context={chat} onClose={close} />
          ) : item.kind === "chat" && chat ? (
            <ChatPreview item={item} context={chat} onClose={close} />
          ) : null}
        </Suspense>
      </OpenLocalLinkProvider>
      </ViewerPlacementProvider>
    </div>
  )
}

export const VIEWER_OVERLAY_EXIT_MS = 150

export interface PresentedViewer {
  viewer: ChatViewerState | null
  /** Closed, and on screen only while it animates out. */
  exiting: boolean
}

/**
 * The viewer as the page shows it: what the chat has open, or for a moment
 * after it closes, what it had open, so it can leave rather than vanish.
 * Beside the chat that's the pane's closing time (the pane closes around
 * it); over the chat, the card's fade. Another chat, or reduced motion,
 * drops it at once.
 */
export function usePresentedViewer(projectId: string | null | undefined, paneAvailable: boolean): PresentedViewer {
  const live = useChatViewer()
  const chatKey = useViewerStore((store) => store.chatKey)
  const shown = live && showsOn(live.item, projectId) ? live : null
  // The last viewer shown, as committed: read in render to keep it on screen
  // the render it closes in, so it never unmounts and mounts again.
  const lastShownRef = useRef<{ viewer: ChatViewerState; chatKey: string } | null>(null)
  const [finished, setFinished] = useState<ChatViewerState | null>(null)
  const last = lastShownRef.current
  const leaving = !shown && last && last.chatKey === chatKey && last.viewer !== finished && !prefersReducedMotion()
    ? last.viewer
    : null
  const exitMs = leaving ? (paneAvailable && !leaving.expanded ? PANE_CLOSE_MS : VIEWER_OVERLAY_EXIT_MS) : 0

  useLayoutEffect(() => {
    if (shown) lastShownRef.current = { viewer: shown, chatKey }
    else if (!leaving) lastShownRef.current = null
  })

  useEffect(() => {
    if (!leaving) return
    const timeout = window.setTimeout(() => setFinished(leaving), exitMs)
    return () => window.clearTimeout(timeout)
  }, [exitMs, leaving])

  return { viewer: shown ?? leaving, exiting: leaving !== null }
}

/** Whether the viewer is showing on this project's page: the page makes room for it, or goes inert under it. */
export function useViewerShown(projectId: string | null | undefined) {
  return showsOn(useChatViewer()?.item ?? null, projectId)
}
