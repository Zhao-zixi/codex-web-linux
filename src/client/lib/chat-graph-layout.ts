import type { ChatGraph } from "./chat-graph"

/**
 * Where the graph view puts each chat, and how a node gets there. Kept
 * React-free for tests.
 */

export interface GraphPoint {
  x: number
  y: number
}

/**
 * Which way the tree grows.
 *
 * - `columns`: left to right, a generation to a column. For a canvas as wide
 *   as a page, where three generations fit side by side.
 * - `outline`: top to bottom, each generation set in a little from the one
 *   above, like the rows of a file tree. For a canvas the width of a pane:
 *   three generations are one node and two indents wide, not three nodes.
 */
export type ChatGraphDirection = "columns" | "outline"

export interface ChatGraphLayoutOptions {
  direction: ChatGraphDirection
  /** Every node is this wide. */
  nodeWidth: number
  /** `columns`: between a parent's right edge and its children's left. */
  columnGap: number
  /** `outline`: how far in each generation sits from the one above. */
  indent: number
  /** Between one node's bottom and the next one's top, in a column. */
  rowGap: number
  /** Stands in for a node that has not been measured yet. */
  estimatedHeight: number
}

/**
 * Lay the tree out left to right: the root at the origin, each chat's
 * sub-chats in the next column, the first of them level with it.
 *
 * Level with the parent's top, not centred on it, and that is the point of
 * the shape. A layout that centres a parent on its children moves the parent,
 * and with it everything above, each time a child is added. Here a chat's
 * place depends only on what comes before it: a new sub-chat goes under its
 * siblings, and the only nodes that move are the ones below it, straight
 * down, to make room. The root never moves at all.
 *
 * Heights are per node because a node holds as much as its chat has to say.
 */
export function layoutChatGraph(
  graph: ChatGraph,
  heights: ReadonlyMap<string, number>,
  options: ChatGraphLayoutOptions,
): Map<string, GraphPoint> {
  const nodeById = new Map(graph.nodes.map((node) => [node.chatId, node]))
  const positions = new Map<string, GraphPoint>()

  if (options.direction === "outline") {
    // `graph.nodes` lists parents before their children and siblings oldest
    // first, which is the order an outline reads in. The same promise as the
    // columns below: a new sub-chat lands under its siblings, and only what
    // comes after it moves, straight down.
    let top = 0
    for (const node of graph.nodes) {
      positions.set(node.chatId, { x: node.depth * options.indent, y: top })
      top += (heights.get(node.chatId) ?? options.estimatedHeight) + options.rowGap
    }
    return positions
  }

  /** Places a chat and all under it; returns the bottom of what it placed. */
  const place = (chatId: string, top: number): number => {
    const node = nodeById.get(chatId)
    if (!node) return top
    positions.set(chatId, { x: node.depth * (options.nodeWidth + options.columnGap), y: top })
    let bottom = top + (heights.get(chatId) ?? options.estimatedHeight)
    let childTop = top
    for (const childId of node.childIds) {
      const childBottom = place(childId, childTop)
      childTop = childBottom + options.rowGap
      bottom = Math.max(bottom, childBottom)
    }
    return bottom
  }
  place(graph.rootId, 0)
  return positions
}

/** How much room the laid-out tree takes, from the origin. */
export function getChatGraphContentSize(
  positions: ReadonlyMap<string, GraphPoint>,
  heights: ReadonlyMap<string, number>,
  options: Pick<ChatGraphLayoutOptions, "nodeWidth" | "estimatedHeight">,
): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const [id, point] of positions) {
    width = Math.max(width, point.x + options.nodeWidth)
    height = Math.max(height, point.y + (heights.get(id) ?? options.estimatedHeight))
  }
  return { width, height }
}

export interface SpringState {
  value: number
  velocity: number
}

/**
 * One step of a critically damped spring toward `target`: the fastest way
 * there that never overshoots.
 *
 * A spring and not a timed curve because the target moves while a node is
 * still on its way (a second sub-chat arrives, a card grows as its reply
 * lands). A spring just takes the new target and carries on from where it is,
 * at the speed it has; a curve would have to start again from rest.
 *
 * Solved exactly rather than stepped, so a long frame cannot make it unstable.
 * `responseSeconds` is about how long it takes to get there.
 */
export function stepCriticalSpring(
  state: SpringState,
  target: number,
  deltaSeconds: number,
  responseSeconds: number,
): SpringState {
  const omega = (2 * Math.PI) / responseSeconds
  const offset = state.value - target
  const decay = Math.exp(-omega * deltaSeconds)
  const slope = state.velocity + omega * offset
  return {
    value: target + (offset + slope * deltaSeconds) * decay,
    velocity: (slope - omega * (offset + slope * deltaSeconds)) * decay,
  }
}

/** Close enough, and slow enough, to stop on the target. In layout pixels. */
export function isSpringAtRest(state: SpringState, target: number): boolean {
  return Math.abs(state.value - target) < 0.5 && Math.abs(state.velocity) < 5
}

export interface GraphViewport {
  x: number
  y: number
  zoom: number
}

/**
 * How the graph is first shown: as large as fits, never larger than life and
 * never too small to read, with the root in view.
 *
 * A graph that cannot be shown whole at a readable size is fitted across
 * only, and runs off the foot of the canvas. Shrinking it further for its
 * height would cost every card its legibility and still not show it all; a
 * tree is read by scrolling down it.
 *
 * `insets` is the part of the canvas other things cover (the navbar, the
 * composer). A graph that fits in a direction is centred in it. One that does
 * not is held at its start, so what is cut off is the far end of the tree and
 * not its head.
 *
 * `focus` is a node the reader came for (the chat they are in). When the graph
 * is too tall and that node would start out of sight, the view starts lower,
 * with the node a quarter of the way down, and never past the tree's end.
 */
export function getInitialGraphViewport(args: {
  /** Size of everything laid out, from the origin. */
  content: { width: number; height: number }
  /** Size of the canvas element. */
  canvas: { width: number; height: number }
  insets: { top: number; right: number; bottom: number; left: number }
  minZoom: number
  maxZoom: number
  /** The top and bottom of a node to have in view, in layout coordinates. */
  focus?: { top: number; bottom: number } | null
}): GraphViewport {
  const { content, canvas, insets } = args
  const roomWidth = Math.max(1, canvas.width - insets.left - insets.right)
  const roomHeight = Math.max(1, canvas.height - insets.top - insets.bottom)
  const fitAcross = content.width > 0 ? roomWidth / content.width : Infinity
  const fitWhole = Math.min(fitAcross, content.height > 0 ? roomHeight / content.height : Infinity)
  const zoom = Math.min(args.maxZoom, Math.max(args.minZoom, fitWhole >= args.minZoom ? fitWhole : fitAcross))
  const spareWidth = roomWidth - content.width * zoom
  const spareHeight = roomHeight - content.height * zoom
  let y = insets.top + Math.max(0, spareHeight / 2)
  if (args.focus && spareHeight < 0 && args.focus.bottom * zoom > roomHeight) {
    const lowest = insets.top + spareHeight
    y = Math.max(lowest, Math.min(insets.top, insets.top + roomHeight / 4 - args.focus.top * zoom))
  }
  return {
    x: insets.left + Math.max(0, spareWidth / 2),
    y,
    zoom,
  }
}
