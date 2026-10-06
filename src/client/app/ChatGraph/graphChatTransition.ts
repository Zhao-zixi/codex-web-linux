/**
 * How a chat picked from the graph opens over it, and goes back: the styles
 * of the layer the chat is on, by phase. See `GraphViewer` for what the motion
 * is for. Kept apart from it, and free of React, so the path can be tested.
 */

/**
 * - `enter`: just picked; the layer is its node, and unseen.
 * - `open`: opening out to the pane, or there.
 * - `rest`: open and settled; nothing is animating and nothing is clipped.
 * - `leave-from`: one frame of `open`'s shape, taken up from `rest` so that
 *   leaving has a shape to start from.
 * - `leave`: closing back into its node.
 */
export type GraphChatPhase = "enter" | "open" | "rest" | "leave-from" | "leave"

/**
 * Opening is the longer of the two: it is the chat arriving, which the reader
 * is watching for. Going back is the reader done with it, and is quicker.
 * Both stay under 300ms; this is used many times in a sitting.
 */
export const GRAPH_CHAT_ENTER_MS = 280
export const GRAPH_CHAT_LEAVE_MS = 200

/** The pane's own curve (`--ease-glide`): for something that travels and settles. */
const TRAVEL_EASING = "var(--ease-glide)"

/** The layer whole. The radius is the viewer card's, so the clip follows its corners. */
const OPEN_CLIP = "inset(0px 0px 0px 0px round 16px)"

/**
 * The clip that leaves only a chat's node showing, as a rectangle of the
 * stage. Null when there is no stage, the chat has no node on the canvas, or
 * the node is panned out of sight: then there is no rectangle to grow from,
 * and the chat fades instead.
 */
export function collapsedChatClip(stage: HTMLElement | null, chatId: string): string | null {
  const node = stage?.querySelector<HTMLElement>(`[data-chat-graph-node="${CSS.escape(chatId)}"]`)
  if (!stage || !node) return null
  return clipToRect(stage.getBoundingClientRect(), node.getBoundingClientRect())
}

interface Box {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * `rect` as a clip of `stage`: how far in from each of the stage's sides.
 * Null when the two do not overlap. A node half off the stage is clipped to
 * the half that shows, since an inset cannot be negative.
 */
export function clipToRect(stage: Box, rect: Box): string | null {
  const top = Math.max(0, rect.top - stage.top)
  const left = Math.max(0, rect.left - stage.left)
  const bottom = Math.max(0, stage.bottom - rect.bottom)
  const right = Math.max(0, stage.right - rect.right)
  const width = stage.right - stage.left - left - right
  const height = stage.bottom - stage.top - top - bottom
  if (width <= 0 || height <= 0) return null
  const round = (value: number) => Math.round(value * 10) / 10
  // The node card's own radius.
  return `inset(${round(top)}px ${round(right)}px ${round(bottom)}px ${round(left)}px round 12px)`
}

export interface GraphChatLayerStyle {
  clipPath?: string
  opacity?: number
  transition?: string
}

/**
 * The layer's style in a phase. `collapsed` is the node's clip, or null to
 * fade without one (the node is out of sight, or motion is reduced).
 *
 * Transform is never used: the layer holds a transcript, and scaling one is
 * what this avoids. Only the clip and the opacity move.
 */
export function getGraphChatLayerStyle(phase: GraphChatPhase, collapsed: string | null): GraphChatLayerStyle {
  switch (phase) {
    case "rest":
      return {}
    case "enter":
      return { opacity: 0, ...(collapsed ? { clipPath: collapsed } : {}) }
    case "open":
      return {
        opacity: 1,
        ...(collapsed ? { clipPath: OPEN_CLIP } : {}),
        // The fade is done well before the shape is: the chat is all there
        // while it is still opening out.
        transition: `clip-path ${GRAPH_CHAT_ENTER_MS}ms ${TRAVEL_EASING}, opacity 160ms ease-out`,
      }
    case "leave-from":
      return { opacity: 1, ...(collapsed ? { clipPath: OPEN_CLIP } : {}) }
    case "leave":
      return {
        opacity: 0,
        ...(collapsed ? { clipPath: collapsed } : {}),
        // Held a moment before it fades, so it is seen heading for its node.
        transition: `clip-path ${GRAPH_CHAT_LEAVE_MS}ms ${TRAVEL_EASING}, opacity ${GRAPH_CHAT_LEAVE_MS - 60}ms ease-out 60ms`,
      }
    default: {
      const unhandled: never = phase
      return unhandled
    }
  }
}
