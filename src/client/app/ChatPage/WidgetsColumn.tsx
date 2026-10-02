import { memo, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChatNavbarWash } from "../../components/chat-ui/ChatNavbar"
import { cn } from "../../lib/utils"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  RIGHT_SIDEBAR_MAX_WIDTH_PX,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
} from "../../stores/rightSidebarStore"
import { paneDurationMs, prefersReducedMotion } from "../paneAnimation"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { useEdgePeek } from "../useEdgePeek"

/** The chat's narrowest, as a share of the page: beside the widget column, and beside the viewer's pane. */
export const CHAT_MIN_WORKSPACE_SIZE_PERCENT = 20

const KEYBOARD_STEP_PX = 16

/**
 * The widget column's width: the width it was given, inside its pixel
 * bounds, and never so wide that the chat drops under its least share.
 */
export function getWidgetsColumnWidthPx(storedPx: number, layoutWidth: number) {
  const requested = Number.isFinite(storedPx) ? storedPx : DEFAULT_RIGHT_SIDEBAR_SIZE
  const clamped = Math.min(RIGHT_SIDEBAR_MAX_WIDTH_PX, Math.max(RIGHT_SIDEBAR_MIN_WIDTH_PX, requested))
  if (!Number.isFinite(layoutWidth) || layoutWidth <= 0) return clamped
  return Math.min(clamped, layoutWidth * ((100 - CHAT_MIN_WORKSPACE_SIZE_PERCENT) / 100))
}

/**
 * Whether the column slides to its new width. Only opening or closing it in
 * place does. Going to a chat or project where it's the other way snaps, as
 * the terminal does. The slide ends on a timer rather than `transitionend`,
 * which a transition that's cut short never sends, and a slide left on would
 * lag a drag or a window resize behind the pointer.
 */
function useColumnSlide(open: boolean, switchKey: string | null) {
  const [slide, setSlide] = useState({ open, switchKey, sliding: false })
  if (slide.open !== open || slide.switchKey !== switchKey) {
    const sliding = slide.switchKey === switchKey && !prefersReducedMotion()
    setSlide({ open, switchKey, sliding })
  }

  useEffect(() => {
    if (!slide.sliding) return
    const timeout = window.setTimeout(() => {
      setSlide((current) => (current.sliding ? { ...current, sliding: false } : current))
    }, paneDurationMs(slide.open) + 50)
    return () => window.clearTimeout(timeout)
  }, [slide])

  return slide.sliding
}

interface WidgetsColumnProps {
  open: boolean
  /** Changes when going to another chat or project: the column snaps there. */
  switchKey: string | null
  /** The width the column was given (the store's), before it's fitted to the page. */
  storedWidthPx: number
  layoutWidth: number
  onResize: (widthPx: number) => void
  /** The closed column is being shown over the chat, or no longer is: its content is on screen. */
  onPeekChange: (peeking: boolean) => void
  content: ReactNode
}

/**
 * The widget column beside the chat on desktop.
 *
 * Its width is a style worked out from state on every render: nothing when
 * closed, the stored width when open. It used to be a panel in a
 * react-resizable-panels group, closed by a `setLayout` after mount. A group
 * that registers before it has a width ignores `setLayout` and, until it's
 * next resized, lays out its panels at their default sizes. The closed column
 * then kept its open width, empty, and pushed the chat left until a reload.
 */
export const WidgetsColumn = memo(function WidgetsColumn({
  open,
  switchKey,
  storedWidthPx,
  layoutWidth,
  onResize,
  onPeekChange,
  content,
}: WidgetsColumnProps) {
  const sliding = useColumnSlide(open, switchKey)
  // The peek (useEdgePeek): the closed column shown over the chat while the
  // mouse is at the window's right edge. Only the last 2px open it, where the
  // left sidebar takes 8: the transcript's scrollbar lives along this edge,
  // and reaching for it must not bring the column down over it.
  const visualRef = useRef<HTMLDivElement>(null)
  // A setting, and off unless turned on (General).
  const peekEnabled = useAppSettingsStore((store) => store.settings?.widgetsPeekEnabled === true)
  const peeking = useEdgePeek({ side: "right", enabled: peekEnabled && !open, panelRef: visualRef, edgePx: 2 })
  useEffect(() => {
    onPeekChange(peeking)
    // The column can go away mid-peek (a narrower window, no project).
    return () => { if (peeking) onPeekChange(false) }
  }, [onPeekChange, peeking])
  // Over the chat rather than beside it: in a peek, and while a column kept
  // from a peek is still making its room.
  const floating = !open || sliding
  const [dragWidthPx, setDragWidthPx] = useState<number | null>(null)
  const dragStartRef = useRef<{ pointerX: number; widthPx: number } | null>(null)
  const widthPx = getWidgetsColumnWidthPx(dragWidthPx ?? storedWidthPx, layoutWidth)
  const durationMs = paneDurationMs(open || peeking)
  const dragging = dragWidthPx !== null

  // The resize cursor, and no text selected, wherever the pointer strays
  // mid-drag, as the left sidebar's drag does.
  useEffect(() => {
    if (!dragging) return
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = "col-resize"
    document.body.style.userSelect = "none"
    return () => {
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
    }
  }, [dragging])

  function commit(nextWidthPx: number) {
    onResize(Math.round(getWidgetsColumnWidthPx(nextWidthPx, layoutWidth)))
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!open || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragStartRef.current = { pointerX: event.clientX, widthPx }
    setDragWidthPx(widthPx)
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    const start = dragStartRef.current
    if (!start) return
    // The column is on the right, so dragging left widens it.
    setDragWidthPx(start.widthPx - (event.clientX - start.pointerX))
  }

  function handlePointerEnd() {
    if (!dragStartRef.current) return
    dragStartRef.current = null
    if (dragWidthPx !== null) commit(dragWidthPx)
    setDragWidthPx(null)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let nextWidthPx: number | null = null
    if (event.key === "ArrowLeft") nextWidthPx = widthPx + KEYBOARD_STEP_PX
    else if (event.key === "ArrowRight") nextWidthPx = widthPx - KEYBOARD_STEP_PX
    else if (event.key === "Home") nextWidthPx = RIGHT_SIDEBAR_MIN_WIDTH_PX
    else if (event.key === "End") nextWidthPx = RIGHT_SIDEBAR_MAX_WIDTH_PX
    else if (event.key === "Enter") nextWidthPx = DEFAULT_RIGHT_SIDEBAR_SIZE
    if (nextWidthPx === null) return
    event.preventDefault()
    commit(nextWidthPx)
  }

  return (
    <>
      {/* No width of its own (w-2 less -mx-1 each side), as the old panel
          separator had: it straddles the seam without moving either side. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize widgets"
        aria-valuenow={Math.round(widthPx)}
        aria-valuemin={RIGHT_SIDEBAR_MIN_WIDTH_PX}
        aria-valuemax={RIGHT_SIDEBAR_MAX_WIDTH_PX}
        aria-hidden={open ? undefined : true}
        tabIndex={open ? 0 : -1}
        className={cn(
          "relative z-10 -mx-1 h-full w-2 shrink-0 cursor-col-resize touch-none focus-visible:outline-none",
          !open && "pointer-events-none",
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onLostPointerCapture={handlePointerEnd}
        onDoubleClick={() => commit(DEFAULT_RIGHT_SIDEBAR_SIZE)}
        onKeyDown={handleKeyDown}
      />
      <div
        // The pane clock and curve (paneAnimation.ts), on the width.
        // Nothing is clipped here: the content runs past this box to the
        // right while it opens or closes, and to the left in a peek. The row
        // this sits at the end of does the clipping (`panes`, ChatPage).
        // Floating, it is raised over the viewer (z-30), under the navbar.
        className={cn("relative h-full min-h-0 shrink-0", sliding && "transition-[width] ease-glide", floating && "z-30")}
        style={{ width: open ? widthPx : 0, transitionDuration: sliding ? `${durationMs}ms` : undefined }}
        inert={!(open || peeking) || undefined}
        data-widgets-column
      >
        {/* At its full width whatever the column's, pinned to the column's
            left edge: opening slides it in from the right rather than
            reflowing every card at each frame. The navbar spans the chat and
            this column: the column scrolls under it into the same fade as
            the transcript (WidgetsSidebar pads its top by the navbar's
            height). */}
        <div
          ref={visualRef}
          className={cn(
            "group/widgets absolute inset-y-0 left-0 min-h-0 overflow-hidden",
            // The peek slides the content back in by a transform, from where
            // the closed column leaves it: just past the window's edge. Its
            // width stays 0, so the chat does not reflow. Opening from a peek
            // widens the column on the same clock and curve as this returns
            // to 0, and the two cancel: the content holds still while the
            // chat makes room for it. No surface or edge of its own: over
            // the chat the widgets are cards floating on it. `data-slideover`
            // lifts them and puts a fade behind them (index.css), kept until
            // a column opened from a peek has made its room.
            peeking && "-translate-x-full",
          )}
          data-slideover={floating || undefined}
          style={{ width: widthPx, "--pane-duration": `${durationMs}ms` } as CSSProperties}
          data-right-sidebar-open={open || peeking ? "true" : "false"}
          // Closed counts as animated: the peek comes and goes from there.
          // Going to a chat where the column is closed still snaps, since
          // the closed content is off screen for whatever it does.
          data-right-sidebar-animated={sliding || (!open && !prefersReducedMotion()) ? "true" : "false"}
          data-right-sidebar-visual
        >
          {content}
          <ChatNavbarWash stopAtTranscriptScrollbar={false} />
        </div>
      </div>
    </>
  )
})
