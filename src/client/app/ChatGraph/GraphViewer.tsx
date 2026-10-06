import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import { Maximize, Network } from "lucide-react"
import { useSidebarThread } from "../../components/chat-ui/chat-reference"
import { ViewerIconButton, ViewerSurface } from "../../components/viewer/ViewerSurface"
import { isNewTabClick } from "../../lib/background-open"
import type { ChatJumpRole } from "../../lib/chat-navigation"
import { cn } from "../../lib/utils"
import { useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import { ChatPreview, type ChatPreviewContext } from "../ChatPage/ChatPreview"
import { prefersReducedMotion } from "../paneAnimation"
import { useOpenChat } from "../useOpenChat"
import { ChatGraphCanvas, type ChatGraphCanvasHandle } from "./ChatGraphCanvas"
import type { ChatGraphHost } from "./ChatGraphNode"
import { collapsedChatClip, getGraphChatLayerStyle, GRAPH_CHAT_ENTER_MS, GRAPH_CHAT_LEAVE_MS, type GraphChatPhase } from "./graphChatTransition"
import { useChatGraphRootId } from "./useChatGraph"

type GraphItem = Extract<ViewerItem, { kind: "graph" }>
type ChatItem = Extract<ViewerItem, { kind: "chat" }>

/** The chat on screen over the graph, which outlives the item by its exit. */
interface PresentedChat {
  item: ChatItem
  phase: GraphChatPhase
  /** The clip that is the chat's node, or null when the node is out of sight. */
  collapsed: string | null
}

/**
 * The graph in the viewer's pane (Cmd+K, "Show Graph"), and the chat picked
 * from it.
 *
 * One view for both items (`{ kind: "graph" }` and a chat that carries
 * `graph`), so picking a chat does not replace the graph: the chat opens over
 * it, and the graph stays mounted underneath, laid out and panned as it was.
 * Back then has somewhere to return to that is exactly where the reader left.
 *
 * The chat is the previewer's own (`ChatPreview`), composer and all. The
 * graph has no composer: what you type goes to the chat in the main view.
 *
 * What moves, and why. Picking a chat is a pointer action on one card, and
 * that card is what the chat is, so the chat grows out of the card: its layer
 * is clipped to the node's rectangle and opens out to the pane while it fades
 * in. Back runs the same path the other way, quicker, into wherever the node
 * is now. A clip and not a scale, because a transcript scaled up from a
 * 320px card is a smear of text for most of the move; clipped, every glyph
 * is at its final size and place from the first frame, and only the window
 * onto it moves. It is a transition between two states of the layer, so a
 * click or a Back that lands mid-move turns it round from where it has got
 * to. Opening the graph itself adds nothing to the pane's own opening: it is
 * asked for from the keyboard.
 */
export const GraphViewer = memo(function GraphViewer({ item, context, onClose }: {
  item: GraphItem | ChatItem
  context: ChatPreviewContext
  onClose: () => void
}) {
  // The chat the graph was opened for. Any chat in the tree would draw the
  // same graph; this is the one a chat picked from it goes back to.
  const graphChatId = item.kind === "graph" ? item.chatId : item.graph ?? item.chatId
  const chatItem = item.kind === "chat" ? item : null
  const pageChatId = useViewerStore((store) => store.chatKey) || null
  const rootId = useChatGraphRootId(graphChatId)
  const rootThread = useSidebarThread(rootId)
  const openChat = useOpenChat()
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<ChatGraphCanvasHandle>(null)

  // A node opens its chat here, in the graph's place, whether or not the chat
  // has a parent: the graph is where chats are picked from, and its head is
  // as much a pick as any. Two exceptions. A click that asks for a tab
  // (Cmd/Ctrl, the middle button) gets what it gets on any chat link. And
  // the chat in the main view opens nothing, which is the node's to know
  // (`currentChatId`): it is already open, beside this.
  const host = useMemo<ChatGraphHost>(() => ({
    currentChatId: pageChatId,
    openChat: (chatId: string, jump?: ChatJumpRole) => {
      if (isNewTabClick()) {
        openChat(chatId, jump ? { jump } : undefined)
        return
      }
      const viewerStore = useViewerStore.getState()
      viewerStore.open({ kind: "chat", chatId, graph: graphChatId })
      if (jump) viewerStore.setChatJump(chatId, jump)
    },
  }), [graphChatId, openChat, pageChatId])

  // Opened on a chat (a reload, or back from a file opened over it), the chat
  // is simply there: nobody picked it just now.
  const [presented, setPresented] = useState<PresentedChat | null>(
    () => (chatItem ? { item: chatItem, phase: "rest", collapsed: null } : null),
  )
  const presentedRef = useRef(presented)
  presentedRef.current = presented

  const readCollapsed = useCallback((chatId: string) => (
    prefersReducedMotion() ? null : collapsedChatClip(stageRef.current, chatId)
  ), [])

  // The item changed: a chat was picked, stepped to, or left for the graph.
  useLayoutEffect(() => {
    const current = presentedRef.current
    const leaving = current?.phase === "leave" || current?.phase === "leave-from"
    if (chatItem) {
      if (current && !leaving) {
        // From one chat to the next inside the previewer: the chat's own
        // business, and it changes in place.
        if (current.item !== chatItem) setPresented({ ...current, item: chatItem })
        return
      }
      if (current?.phase === "leave") {
        // Picked while the last chat was still on its way out. Its layer is
        // mid-move, so it turns round from where it has got to and opens
        // again, on the new chat, instead of starting over from a node.
        setPresented({ ...current, item: chatItem, phase: "open" })
        return
      }
      setPresented({ item: chatItem, phase: "enter", collapsed: readCollapsed(chatItem.chatId) })
      return
    }
    if (!current || leaving) return
    if (current.phase === "rest") {
      // At rest the layer has no clip to move from, so it is given the open
      // one for a frame first (`leave-from`), aimed at where its node is now.
      setPresented({ ...current, phase: "leave-from", collapsed: readCollapsed(current.item.chatId) })
    } else {
      // Still opening: it goes back the way it was coming, from where it is.
      setPresented({ ...current, phase: "leave" })
    }
  }, [chatItem, readCollapsed])

  // Each phase hands on to the next. The two that are a starting state
  // (`enter`, `leave-from`) are committed, read back so the browser has
  // them, and replaced before it paints: that is what gives the transition
  // somewhere to start from.
  const phase = presented?.phase ?? null
  useLayoutEffect(() => {
    if (phase === "enter" || phase === "leave-from") {
      void stageRef.current?.getBoundingClientRect()
      setPresented((current) => (
        current && current.phase === phase ? { ...current, phase: phase === "enter" ? "open" : "leave" } : current
      ))
      return
    }
    if (phase === "open") {
      const timer = window.setTimeout(() => {
        setPresented((current) => (current?.phase === "open" ? { ...current, phase: "rest" } : current))
      }, GRAPH_CHAT_ENTER_MS)
      return () => window.clearTimeout(timer)
    }
    if (phase === "leave") {
      const timer = window.setTimeout(() => {
        setPresented((current) => (current?.phase === "leave" ? null : current))
        // The chat took focus when it opened and has taken it with it. Given
        // to the graph, unless the reader has since put it somewhere else.
        const active = document.activeElement
        if (!active || active === document.body || stageRef.current?.contains(active)) {
          stageRef.current?.querySelector<HTMLElement>("[data-viewer-surface]")?.focus({ preventScroll: true })
        }
      }, GRAPH_CHAT_LEAVE_MS)
      return () => window.clearTimeout(timer)
    }
  }, [phase])

  // Under a chat the graph is not for use, and once the chat has finished
  // opening it is not for drawing either: it is wholly covered. It stays laid
  // out, which is what lets a chat find its node on the way back.
  const leaving = presented?.phase === "leave"
  const covered = presented !== null && !leaving
  const hidden = presented?.phase === "rest"

  const handleFit = useCallback(() => canvasRef.current?.fit(), [])
  // Stable while the graph is: the canvas does not redraw for a chat opening over it.
  const canvas = useMemo(() => (
    <ChatGraphCanvas
      // By root, as on the graph's page: the same tree is the same canvas
      // whichever of its chats it was opened for.
      key={rootId ?? graphChatId}
      chatId={graphChatId}
      markedChatId={pageChatId}
      // Keep the same layout as /graph/:chatId when the graph opens in a pane.
      direction="columns"
      host={host}
      handleRef={canvasRef}
    />
  ), [graphChatId, host, pageChatId, rootId])

  return (
    <div ref={stageRef} className="relative h-full">
      <div inert={covered || undefined} className={cn("h-full", hidden && "invisible")}>
        <ViewerSurface
          label="Graph of this chat and its sub-chats"
          icon={<Network />}
          title="Graph"
          subtitle={rootThread?.title}
          toolbar={(
            <ViewerIconButton label="Fit graph" onClick={handleFit}>
              <Maximize />
            </ViewerIconButton>
          )}
          onClose={onClose}
          bodyClassName="relative overflow-hidden"
        >
          {canvas}
        </ViewerSurface>
      </div>
      {presented ? (
        // On its way out the chat is no longer in the way: the graph under it
        // can be used at once, and a node picked then turns the move round.
        <div
          inert={leaving || undefined}
          className={cn("absolute inset-0", leaving && "pointer-events-none")}
          style={getGraphChatLayerStyle(presented.phase, presented.collapsed) as CSSProperties}
        >
          <ChatPreview item={presented.item} context={context} onClose={onClose} />
        </div>
      ) : null}
    </div>
  )
})
