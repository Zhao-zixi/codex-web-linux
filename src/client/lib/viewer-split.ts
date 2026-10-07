/**
 * How the chat page's split, the chat column beside the viewer's pane,
 * follows the viewer.
 *
 * The split is the chat's width, so moving it is layout: every step re-wraps
 * the transcript and re-measures the frames and tables in it. That is worth
 * showing when the chat is making room for a pane beside it. Under a pane
 * that covers the chat it is work nobody sees, and it leaves the transcript
 * somewhere other than where it was. So:
 *
 *   - Expanded, the split is left alone. A viewer opened straight to
 *     expanded never narrows the chat, and one expanded from its pane keeps
 *     the chat as narrow as it was, so collapsing finds it ready.
 *   - Out of expanded, the split is set in one step, to the pane's width or
 *     to nothing, while the viewer still covers the chat. One reflow, behind
 *     the card, instead of one per frame beside it.
 *   - Between closed and docked, and between two docked widths (a review and
 *     a preview), it slides, as it always has.
 */
export type ViewerPaneState = "closed" | "docked" | "expanded"

export function viewerPaneState(open: boolean, expanded: boolean): ViewerPaneState {
  if (!open) return "closed"
  return expanded ? "expanded" : "docked"
}

export interface ViewerSplitMove {
  /** Where the split goes: nowhere, shut, or to the docked width of what is open. */
  to: "hold" | "closed" | "docked"
  /** Slide there, rather than take it in one step. */
  animate: boolean
}

/**
 * `continuous` is false when a slide would not read as one pane moving: the
 * page is on another chat or a new split, or motion is reduced.
 */
export function resolveViewerSplitMove(previous: ViewerPaneState, next: ViewerPaneState, continuous: boolean): ViewerSplitMove {
  if (next === "expanded") return { to: "hold", animate: false }
  return { to: next, animate: continuous && previous !== "expanded" && (previous === "docked" || next === "docked") }
}
