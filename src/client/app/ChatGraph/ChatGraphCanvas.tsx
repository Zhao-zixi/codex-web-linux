import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react"
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react"
import "@xyflow/react/dist/base.css"
import "./chat-graph.css"
import { Maximize } from "lucide-react"
import { Button } from "../../components/ui/button"
import type { ChatGraph } from "../../lib/chat-graph"
import {
  getChatGraphContentSize,
  getInitialGraphViewport,
  isSpringAtRest,
  layoutChatGraph,
  stepCriticalSpring,
  type ChatGraphDirection,
  type ChatGraphLayoutOptions,
  type GraphPoint,
  type GraphViewport,
  type SpringState,
} from "../../lib/chat-graph-layout"
import { cn } from "../../lib/utils"
import { useSidebarReady } from "../../stores/sidebarStore"
import { prefersReducedMotion } from "../paneAnimation"
import {
  CHAT_GRAPH_NODE_INTERACTION,
  CHAT_GRAPH_NODE_WIDTH,
  CHAT_GRAPH_OUTLINE_STEM_LEFT,
  CHAT_GRAPH_SOURCE_HANDLE,
  ChatGraphHostContext,
  ChatGraphNode,
  ChatGraphNowContext,
  type ChatGraphFlowNode,
  type ChatGraphHost,
} from "./ChatGraphNode"
import { useChatGraph, useChatGraphTones } from "./useChatGraph"

const LAYOUTS: Record<ChatGraphDirection, ChatGraphLayoutOptions> = {
  columns: {
    direction: "columns",
    nodeWidth: CHAT_GRAPH_NODE_WIDTH,
    // Room for the elbow of an edge, and for the eye to tell columns apart.
    columnGap: 72,
    indent: 0,
    rowGap: 16,
    // A card with a two-line prompt and a short reply. Only stands in until a
    // node is measured, which is before it is ever shown.
    estimatedHeight: 150,
  },
  outline: {
    direction: "outline",
    nodeWidth: CHAT_GRAPH_NODE_WIDTH,
    columnGap: 0,
    // Twice the stem's distance in, so the trunk the children hang from runs
    // down the middle of the gutter.
    indent: CHAT_GRAPH_OUTLINE_STEM_LEFT * 2,
    rowGap: 12,
    estimatedHeight: 150,
  },
}

const NODE_TYPES = { chat: ChatGraphNode }

const OUTLINE_CORNER_PX = 8

/**
 * An outline's edge: down from the foot of the parent, then round a corner
 * into the side of the child. The children of one chat all leave from the
 * same point, so the first leg of each is one trunk they branch off.
 *
 * Drawn here and not as one of React Flow's step edges, which leave a handle
 * by a set distance before they turn. Out of a child's side that distance
 * would carry the line back past the trunk it came down.
 */
function OutlineEdge({ sourceX, sourceY, targetX, targetY, ...edge }: EdgeProps) {
  const corner = Math.max(0, Math.min(OUTLINE_CORNER_PX, targetX - sourceX, targetY - sourceY))
  const path = `M ${sourceX} ${sourceY} V ${targetY - corner} Q ${sourceX} ${targetY} ${sourceX + corner} ${targetY} H ${targetX}`
  return <BaseEdge path={path} style={edge.style} interactionWidth={0} />
}

const EDGE_TYPES = { outline: OutlineEdge }

/** What a host can ask of a canvas it holds. */
export interface ChatGraphCanvasHandle {
  /** Shows the graph whole again, or its head if it is too big to. */
  fit: () => void
}

/**
 * How long the graph waits, once drawn, before it is shown. Each card asks
 * for its chat's last exchange as it mounts, and grows when that lands. Held
 * for this long, nearly all of them have, and the graph appears once, laid
 * out, instead of settling in front of the reader.
 */
const REVEAL_HOLD_MS = 250
/**
 * How long the canvas has to have held one size before the first view is
 * fitted to it. In the previewer the canvas mounts in a pane that is still
 * sliding open, and a view fitted to the pane half open would be the wrong
 * one for the rest of its life: nothing fits it again but the reader.
 */
const CANVAS_SETTLE_MS = 120
/** About how long a node takes to reach a new place. Apple's value for moving something on screen is 0.4; cards a short way from home want a little less. */
const MOVE_RESPONSE_SECONDS = 0.35
/** What the first view may zoom between: never larger than life, never too small to read. */
const INITIAL_MIN_ZOOM = 0.6
const INITIAL_MAX_ZOOM = 1
/** Space kept clear around the graph when it is fitted to the canvas. */
const CANVAS_MARGIN_PX = 24

interface NodeSpring {
  x: SpringState
  y: SpringState
}

function restingAt(point: GraphPoint): NodeSpring {
  return { x: { value: point.x, velocity: 0 }, y: { value: point.y, velocity: 0 } }
}

/** The nodes for a tree: the ones already drawn kept as they are, new ones added where their springs sit. */
function reconcileNodes(
  current: ChatGraphFlowNode[],
  graph: ChatGraph,
  springs: ReadonlyMap<string, NodeSpring>,
  markedChatId: string | null,
  entering: boolean,
): ChatGraphFlowNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]))
  return graph.nodes.map((graphNode) => {
    const existing = currentById.get(graphNode.chatId)
    const spring = springs.get(graphNode.chatId)
    const position = spring ? { x: spring.x.value, y: spring.y.value } : { x: 0, y: 0 }
    const marked = graphNode.chatId === markedChatId
    if (!existing) {
      return { id: graphNode.chatId, type: "chat" as const, position, data: { marked, entering } }
    }
    const moved = existing.position.x !== position.x || existing.position.y !== position.y
    if (!moved && existing.data.marked === marked) return existing
    // Spread, so what React Flow measured of the node stays on it. A node
    // handed back without its size is hidden until it is measured again, and
    // one whose size has not changed never is.
    return {
      ...existing,
      position: moved ? position : existing.position,
      data: existing.data.marked === marked ? existing.data : { ...existing.data, marked },
    }
  })
}

/**
 * The graph's canvas: a chat and every chat started under it, as a tree. It
 * is shown in two places, the graph's own page (`/graph/:chatId`) and the
 * previewer's pane (`GraphViewer`), and is the same in both. What differs is
 * handed in: which way the tree grows (`direction`), what lies over the
 * canvas's edges, and what a click on a node does (`host`).
 *
 * Everything on it comes from the sidebar snapshot, which already holds every
 * chat with its parent link and is pushed as chats start, run and finish. A
 * sub-chat appearing, a status changing and a reply landing all arrive that
 * way, with nothing asked for here.
 *
 * What moves, and why:
 * - A new node fades and grows in from where its edge meets it. It is the
 *   one thing on the canvas that was not there before, and should not just
 *   be there.
 * - Nodes below it glide down to make room, on a spring, so a second arrival
 *   mid-move bends the motion instead of restarting it. Nothing else moves:
 *   see `layoutChatGraph`.
 * - The view itself never moves on its own. The canvas is the reader's to
 *   pan, and a graph that recentred as it grew would pull what they were
 *   reading out from under them.
 * Under reduced motion nodes take their places at once and arrivals only fade.
 */
export function ChatGraphCanvas({
  chatId,
  markedChatId,
  direction,
  host,
  underNavbar = false,
  bottomInset = 0,
  fitButton = false,
  handleRef,
}: {
  /** Any chat in the tree; the tree is drawn from its root. */
  chatId: string
  /** See `ChatGraphNodeData.marked`. */
  markedChatId: string | null
  /** Fixed for the life of the canvas. */
  direction: ChatGraphDirection
  host: ChatGraphHost
  /** The page's navbar lies over the top of the canvas (it publishes its height as `--chat-navbar-h`). */
  underNavbar?: boolean
  /** How much of the canvas's foot something covers: the page's composer. */
  bottomInset?: number
  /** Draws the fit control on the canvas, for a host with no header to put it in. */
  fitButton?: boolean
  handleRef?: Ref<ChatGraphCanvasHandle>
}) {
  const LAYOUT = LAYOUTS[direction]
  const graph = useChatGraph(chatId)
  const tones = useChatGraphTones(graph)
  const sidebarReady = useSidebarReady()
  const containerRef = useRef<HTMLDivElement>(null)
  const [flow, setFlow] = useState<ReactFlowInstance<ChatGraphFlowNode, Edge> | null>(null)
  const [nodes, setNodes] = useState<ChatGraphFlowNode[]>([])
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(() => new Set())
  const [revealed, setRevealed] = useState(false)
  const revealedRef = useRef(false)
  const firstDrawnAtRef = useRef<number | null>(null)

  const targets = useMemo(
    () => (graph ? layoutChatGraph(graph, heights, LAYOUT) : new Map<string, GraphPoint>()),
    [LAYOUT, graph, heights],
  )
  const targetsRef = useRef(targets)
  const heightsRef = useRef(heights)
  heightsRef.current = heights
  const bottomInsetRef = useRef(bottomInset)
  bottomInsetRef.current = bottomInset
  const underNavbarRef = useRef(underNavbar)
  underNavbarRef.current = underNavbar
  const markedChatIdRef = useRef(markedChatId)
  markedChatIdRef.current = markedChatId

  const springsRef = useRef(new Map<string, NodeSpring>())
  const frameRef = useRef<number | null>(null)
  const lastFrameAtRef = useRef(0)

  const tick = useCallback((now: number) => {
    // A frame that took long (a hidden tab coming back) is not a long stretch
    // of motion to catch up on.
    const deltaSeconds = Math.min(0.1, (now - lastFrameAtRef.current) / 1000)
    lastFrameAtRef.current = now
    const springs = springsRef.current
    let moving = false
    for (const [id, spring] of springs) {
      const target = targetsRef.current.get(id)
      if (!target) continue
      // Each axis on its own spring: one distance for both would tie a short
      // move across to a long move down.
      for (const axis of ["x", "y"] as const) {
        if (isSpringAtRest(spring[axis], target[axis])) {
          spring[axis] = { value: target[axis], velocity: 0 }
        } else {
          spring[axis] = stepCriticalSpring(spring[axis], target[axis], deltaSeconds, MOVE_RESPONSE_SECONDS)
          moving = true
        }
      }
    }
    setNodes((current) => current.map((node) => {
      const spring = springs.get(node.id)
      if (!spring || (node.position.x === spring.x.value && node.position.y === spring.y.value)) return node
      return { ...node, position: { x: spring.x.value, y: spring.y.value } }
    }))
    frameRef.current = moving ? window.requestAnimationFrame(tick) : null
  }, [])

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    // Cleared too: the next move starts the loop only when none is running.
    frameRef.current = null
  }, [])

  // The tree changed shape, or a node changed size: every node has a place
  // to be, and the ones not there start toward it.
  useLayoutEffect(() => {
    targetsRef.current = targets
    const springs = springsRef.current
    if (!graph) {
      springs.clear()
      setNodes((current) => (current.length === 0 ? current : []))
      return
    }
    // Until the graph is shown there is nobody to see a node travel, and what
    // moves it then is its neighbours being measured for the first time.
    const animate = revealedRef.current && !prefersReducedMotion()
    const present = new Set(graph.nodes.map((node) => node.chatId))
    for (const id of [...springs.keys()]) {
      if (!present.has(id)) springs.delete(id)
    }
    const arrived: string[] = []
    for (const node of graph.nodes) {
      const target = targets.get(node.chatId)
      if (!target) continue
      // A new node starts in its place: it arrives by appearing, not by
      // travelling. The ones it displaces do the travelling.
      if (!springs.has(node.chatId)) {
        springs.set(node.chatId, restingAt(target))
        if (revealedRef.current) arrived.push(node.chatId)
      } else if (!animate) {
        springs.set(node.chatId, restingAt(target))
      }
    }
    if (firstDrawnAtRef.current === null) firstDrawnAtRef.current = performance.now()
    if (arrived.length > 0) setEnteringIds((current) => new Set([...current, ...arrived]))
    setNodes((current) => reconcileNodes(current, graph, springs, markedChatId, revealedRef.current))
    if (animate && frameRef.current === null) {
      lastFrameAtRef.current = performance.now()
      frameRef.current = window.requestAnimationFrame(tick)
    }
  }, [graph, markedChatId, targets, tick])

  const handleNodesChange = useCallback((changes: NodeChange<ChatGraphFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
    const measured = changes.flatMap((change) => (
      change.type === "dimensions" && change.dimensions ? [[change.id, Math.round(change.dimensions.height)] as const] : []
    ))
    if (measured.length === 0) return
    setHeights((current) => {
      if (measured.every(([id, height]) => current.get(id) === height)) return current
      const next = new Map(current)
      for (const [id, height] of measured) next.set(id, height)
      return next
    })
  }, [])

  /** The view that shows the graph whole, or its head if it is too big to. */
  const getFittedViewport = useCallback((): GraphViewport | null => {
    const container = containerRef.current
    if (!container || targetsRef.current.size === 0) return null
    const navbarHeight = underNavbarRef.current
      ? Number.parseFloat(getComputedStyle(container).getPropertyValue("--chat-navbar-h")) || 53
      : 0
    // The marked chat is the one the reader came for. In a tree too tall to
    // show whole, the view starts where it can be seen.
    const markedId = markedChatIdRef.current
    const markedAt = markedId ? targetsRef.current.get(markedId) : undefined
    return getInitialGraphViewport({
      content: getChatGraphContentSize(targetsRef.current, heightsRef.current, LAYOUT),
      canvas: { width: container.clientWidth, height: container.clientHeight },
      insets: {
        top: navbarHeight + CANVAS_MARGIN_PX,
        right: CANVAS_MARGIN_PX,
        bottom: bottomInsetRef.current + CANVAS_MARGIN_PX,
        left: CANVAS_MARGIN_PX,
      },
      minZoom: INITIAL_MIN_ZOOM,
      maxZoom: INITIAL_MAX_ZOOM,
      focus: markedId && markedAt ? {
        top: markedAt.y,
        bottom: markedAt.y + (heightsRef.current.get(markedId) ?? LAYOUT.estimatedHeight),
      } : null,
    })
  }, [LAYOUT])

  // Shown once: when every node has been measured and has had a moment to
  // fill in. The view is set here and never again by anything but the reader
  // (and the fit button, which is the reader). In particular not when the
  // canvas changes size, so a pane opening beside the graph narrows the
  // canvas and leaves every node where it was on screen.
  const allMeasured = nodes.length > 0 && nodes.every((node) => node.measured?.height != null)
  const hasGraph = graph !== null
  const lastResizedAtRef = useRef(0)
  useEffect(() => {
    const container = containerRef.current
    if (!hasGraph || !container) return
    const observer = new ResizeObserver(() => {
      lastResizedAtRef.current = performance.now()
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [hasGraph])
  useEffect(() => {
    if (revealed || !flow || !allMeasured) return
    const drawnFor = performance.now() - (firstDrawnAtRef.current ?? performance.now())
    let timer = 0
    const reveal = () => {
      const settledFor = performance.now() - lastResizedAtRef.current
      if (settledFor < CANVAS_SETTLE_MS) {
        timer = window.setTimeout(reveal, CANVAS_SETTLE_MS - settledFor)
        return
      }
      const viewport = getFittedViewport()
      if (viewport) void flow.setViewport(viewport)
      revealedRef.current = true
      setRevealed(true)
    }
    timer = window.setTimeout(reveal, Math.max(0, REVEAL_HOLD_MS - drawnFor))
    return () => window.clearTimeout(timer)
  }, [allMeasured, flow, getFittedViewport, revealed])

  const handleFit = useCallback(() => {
    const viewport = getFittedViewport()
    if (!flow || !viewport) return
    void flow.setViewport(viewport, { duration: prefersReducedMotion() ? 0 : 300 })
  }, [flow, getFittedViewport])
  useImperativeHandle(handleRef, () => ({ fit: handleFit }), [handleFit])

  const edges = useMemo<Edge[]>(() => (graph?.nodes ?? []).flatMap((node) => {
    if (!node.parentChatId) return []
    const tone = tones.get(node.chatId)
    return [{
      id: `${node.parentChatId}>${node.chatId}`,
      source: node.parentChatId,
      sourceHandle: CHAT_GRAPH_SOURCE_HANDLE[direction],
      target: node.chatId,
      // Columns: out of the parent, down the gap between columns, into the
      // child. The children of one chat share the first two legs, which
      // draws them as branches off one trunk. An outline's edge does the
      // same turned on its side: see `OutlineEdge`.
      ...(direction === "outline" ? { type: "outline" } : { type: "smoothstep", pathOptions: { borderRadius: 12 } }),
      focusable: false,
      selectable: false,
      className: cn(
        (tone === "working" || tone === "waiting") && "chat-graph-edge-live",
        node.adopted && "chat-graph-edge-adopted",
        enteringIds.has(node.chatId) && "chat-graph-edge-enter",
      ),
    }]
  }), [direction, enteringIds, graph, tones])

  // The age labels' clock. Slow: they read in minutes.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!graph) {
    return sidebarReady ? (
      <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
        This chat no longer exists.
      </div>
    ) : null
  }

  return (
    <div
      ref={containerRef}
      className={cn(
        "chat-graph absolute inset-0 transition-opacity duration-200 ease-out",
        revealed ? "opacity-100" : "opacity-0",
      )}
    >
      <ChatGraphHostContext.Provider value={host}>
      <ChatGraphNowContext.Provider value={nowMs}>
        <ReactFlow<ChatGraphFlowNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={handleNodesChange}
          onInit={setFlow}
          // The layout places the nodes; the reader moves the canvas. With
          // nothing to drag, a drag that starts on a node pans too.
          {...CHAT_GRAPH_NODE_INTERACTION}
          nodesConnectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          // Two fingers scroll the canvas and a pinch zooms it, as in every
          // other canvas on a trackpad; a wheel scrolls down the tree.
          panOnScroll
          zoomOnScroll={false}
          zoomOnDoubleClick={false}
          // Since a press on a node may be the start of a pan, the canvas has
          // to tell the two apart, and swallows the click of any press that
          // moved further than this. React Flow's own 1px took an ordinary
          // click on a trackpad, where pressing rolls the finger, for a pan.
          paneClickDistance={4}
          minZoom={0.25}
          maxZoom={1.5}
          // Keys belong to the composer below.
          disableKeyboardA11y
          deleteKeyCode={null}
          selectionKeyCode={null}
          multiSelectionKeyCode={null}
          panActivationKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.5} />
        </ReactFlow>
      </ChatGraphNowContext.Provider>
      </ChatGraphHostContext.Provider>
      {fitButton ? (
        <Button
          variant="ghost"
          size="icon"
          title="Fit graph to view"
          aria-label="Fit graph to view"
          onClick={handleFit}
          className="absolute left-3 top-[calc(var(--chat-navbar-h,53px)+8px)] z-10 h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <Maximize className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}
