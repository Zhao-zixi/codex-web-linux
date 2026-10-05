import { useEffect, useState, type RefObject } from "react"

/** How far past the panel's inner edge the mouse may stray before the panel leaves. */
const PEEK_SLOP_PX = 16

/**
 * A menu, select or dialog that is up. They portal out of the panel, so the
 * pointer is over one of these while it is no longer over the panel.
 */
export const OPEN_LAYER_SELECTOR = "[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"

interface EdgePeekOptions {
  side: "left" | "right"
  /** The panel is closed, so there is something to peek at. */
  enabled: boolean
  /** The panel as it is laid out: its width and its vertical extent are read from it. */
  panelRef: RefObject<HTMLElement | null>
  /** How close to the window's edge the mouse opens the peek. */
  edgePx: number
  /** The gap between the window's edge and the panel once it is shown. */
  insetPx?: number
}

/**
 * The peek: a closed side panel comes back as an overlay while the mouse is
 * at its edge of the window, and leaves as soon as the mouse has left it.
 * Nothing is opened: this only says when to show the panel over the chat.
 *
 * Listened for on the document rather than on a strip along the edge. A
 * strip would take the clicks that land on it, and a fast mouse crosses a few
 * pixels between two events; the move that leaves the window by that side is
 * caught instead, which is also what makes the edge easy to hit when the
 * window is not against the screen's.
 */
export function useEdgePeek({ side, enabled, panelRef, edgePx, insetPx = 0 }: EdgePeekOptions) {
  const [requested, setRequested] = useState(false)
  if (!enabled && requested) setRequested(false)

  useEffect(() => {
    if (!enabled) return
    let open = false

    function show() {
      open = true
      setRequested(true)
    }

    function hide() {
      open = false
      setRequested(false)
    }

    // The distance from the panel's side of the window, so both sides read alike.
    function fromEdge(event: MouseEvent) {
      return side === "left" ? event.clientX : window.innerWidth - event.clientX
    }

    // The panel may not run the window's whole height (the terminal sits
    // under the right one): its edge is only the part it stands beside.
    function besidePanel(event: MouseEvent, slopPx: number) {
      const rect = panelRef.current?.getBoundingClientRect()
      return Boolean(rect) && event.clientY >= rect!.top - slopPx && event.clientY <= rect!.bottom + slopPx
    }

    // Whether something the panel started is still going on: a drag (resize,
    // reorder), a menu or dialog opened from a row, a rename being typed.
    // Closing under any of them would take away what the user is using.
    function isBusy(event: MouseEvent) {
      if (event.buttons !== 0) return true
      if (document.querySelector(OPEN_LAYER_SELECTOR)) return true
      const focused = document.activeElement
      return focused instanceof HTMLElement
        && (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")
        && Boolean(panelRef.current?.contains(focused))
    }

    // The peek belongs to the window you are working in. Once another app
    // (or another window) is in front, a panel left hanging over the chat is
    // in the way of reading what is behind it, and a mouse crossing this
    // window's edge on its way somewhere else is not asking for it. So it
    // leaves when the window loses focus, whatever was going on in it, and
    // stays away until the window has focus again.
    function handleWindowBlur() {
      hide()
    }

    // The blur event is not the whole story: a window can stop being the one
    // in front without the page being told (focus was in another part of the
    // app's window, or already gone when the peek came up). So while the
    // peek is up, the question is also asked outright, a few times a second.
    const focusWatch = window.setInterval(() => {
      if (open && !document.hasFocus()) hide()
    }, 200)

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") hide()
    }

    function handlePointerMove(event: PointerEvent) {
      if (event.pointerType !== "mouse") return
      if (fromEdge(event) <= edgePx && besidePanel(event, 0)) {
        if (!open && event.buttons === 0 && document.hasFocus()) show()
        return
      }
      const panel = panelRef.current
      if (!open || !panel) return
      // Where the panel rests, not where it is: a mouse that outruns the
      // panel on its way in is still headed for it.
      const overPanel = fromEdge(event) <= insetPx + panel.offsetWidth + PEEK_SLOP_PX
        && besidePanel(event, PEEK_SLOP_PX)
      if (!overPanel && !isBusy(event)) hide()
    }

    function handleMouseLeave(event: MouseEvent) {
      if (fromEdge(event) <= 0 && besidePanel(event, 0)) {
        if (!open && event.buttons === 0 && document.hasFocus()) show()
      } else if (open && !isBusy(event)) {
        hide()
      }
    }

    window.addEventListener("pointermove", handlePointerMove)
    window.addEventListener("blur", handleWindowBlur)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    document.documentElement.addEventListener("mouseleave", handleMouseLeave)
    return () => {
      window.removeEventListener("pointermove", handlePointerMove)
      window.removeEventListener("blur", handleWindowBlur)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.clearInterval(focusWatch)
      document.documentElement.removeEventListener("mouseleave", handleMouseLeave)
    }
  }, [edgePx, enabled, insetPx, panelRef, side])

  return enabled && requested
}
