import { type ComponentPropsWithoutRef, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import * as PopoverPrimitive from "@radix-ui/react-popover"
import { useHasFinePointer } from "../../lib/pointer"
import { cn } from "../../lib/utils"

/**
 * The surface every hover card in the app shares: the chat and channel cards
 * beside the left sidebar, and the widget column's on the right.
 *
 * `px-1.5` rather than the `px-3` this looks like: the other half lives on each
 * row (`TURN_CARD_ROW_INSET`), so text still lands 12px from the edge while a
 * row's hover fill can run wider than it.
 *
 * It enters with an animation and leaves with none. A card that fades out is a
 * card still on screen over the row you have already moved to, and down a fast
 * pointer those overlap.
 */
export const HOVER_CARD_SURFACE_CLASSNAME =
  "z-50 w-80 rounded-lg border border-border bg-popover/95 px-1.5 py-2 text-xs text-popover-foreground shadow-xl outline-none backdrop-blur-sm animate-in fade-in-0 zoom-in-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 data-[state=closed]:hidden"

/**
 * Draws the safe triangle (see `ListHoverCard`) so it can be seen while its
 * shape and timing are being judged. Off, nothing about the behaviour changes.
 */
const SHOW_SAFE_TRIANGLE = false

/** How far behind the pointer the triangle's point sits, so the pointer is inside it and not on its tip. */
const SAFE_TRIANGLE_APEX_BACKSET_PX = 6
/**
 * How long the pointer may rest inside the triangle on another row before
 * that row gets the card after all. Resting there is not aiming at the card.
 */
const SAFE_TRIANGLE_REST_MS = 300

/** How close to the window's edges a card may come. */
const COLLISION_PADDING_PX = 12

/**
 * A CSS variable on the card: the height from its top, when that is level
 * with its row, to the bottom of the window.
 *
 * For a card with a list in it that can outgrow the window. Cap the list at
 * `max(<a minimum>, this)` and the card behaves as a menu bar's menu does:
 * it opens level with its row and runs to the bottom of the window,
 * scrolling inside, and only where a row sits too low to leave it the
 * minimum does it rise above the row to make room (Radix shifts a card that
 * doesn't fit, by exactly what it lacks).
 */
export const LIST_HOVER_CARD_ROOM_BELOW = "--list-hover-card-room-below"

interface Point {
  x: number
  y: number
}

function isInsideTriangle(point: Point, a: Point, b: Point, c: Point) {
  const side = (p: Point, q: Point, r: Point) => (p.x - r.x) * (q.y - r.y) - (q.x - r.x) * (p.y - r.y)
  const first = side(point, a, b)
  const second = side(point, b, c)
  const third = side(point, c, a)
  const hasNegative = first < 0 || second < 0 || third < 0
  const hasPositive = first > 0 || second > 0 || third > 0
  return !(hasNegative && hasPositive)
}

/**
 * A list's hover card: one card for the whole list, anchored to whichever row
 * is under the pointer.
 *
 * One instance rather than a card per row, because "at most one card, on the
 * row under the pointer" then holds by construction. A card on every row left
 * that to N state machines racing a pointer that crosses several rows in a
 * frame, and each could get stuck open on its own. It is also what a list of
 * hundreds of rows can afford: rows carry no hover state and no trigger, and
 * an idle row costs nothing.
 *
 * Rows mark themselves with `rowAttribute`; delegated pointer listeners on the
 * list read it. `children` renders the card for a hovered key, or null for a
 * row with nothing to add (the card then stays closed). `dismiss` closes it
 * and holds it closed until the pointer reaches another row; call it before
 * an action that takes the user elsewhere.
 *
 * Getting from the row to the card is covered two ways:
 *
 *   - The bridge: an invisible strip of the card over the gap, so a pointer
 *     going straight across never leaves the card's hitbox.
 *   - The safe triangle: a card is taller than its row, so the natural path
 *     to most of it is a diagonal across the rows above or below. While the
 *     pointer is inside the triangle from where it left the row to the card's
 *     near edge, those rows don't take the card. It is geometry, not an
 *     element: nothing covers the rows, so they still take clicks and scroll.
 *     A pointer that stops inside it has stopped aiming, and the row it is on
 *     gets the card.
 *
 * Desktop only: hover isn't a touch gesture, and a card that opened on tap
 * would fight the row's own tap.
 *
 * Cards nest: a card rendered inside another's `children` (the chats listed in
 * a channel's card) keeps the outer one open while the pointer is over it,
 * because React counts a portal's contents as inside the tree that rendered
 * them.
 */
export function ListHoverCard({
  containerRef,
  rowAttribute = "data-row-key",
  side,
  sideOffset = 15,
  alignOffset = 0,
  keepOpenOnRowClick = false,
  pinnedKey = null,
  onUnpin,
  alignTo,
  children,
  className,
}: {
  /** The list; every row the card describes is somewhere beneath it. */
  containerRef: RefObject<HTMLElement | null>
  /** The attribute rows carry their key in. */
  rowAttribute?: string
  /** Which side of the row the card opens on: away from the window's edge. */
  side: "left" | "right"
  /**
   * The gap between the row and the card. The default clears a sidebar's
   * edge, so the card reads as beside it. Negative laps the card over
   * whatever the row sits in: a card raised from inside another card.
   */
  sideOffset?: number
  /**
   * A click anywhere outside the card closes it, the row it describes
   * included: the click took you somewhere, and the card would hang over it.
   * Set where clicking a row acts on its card instead of leaving it.
   */
  keepOpenOnRowClick?: boolean
  /**
   * Holds the card open on this row whatever the pointer does. A hover is a
   * peek and ends when the pointer leaves; a click on the row is a decision,
   * and what it opened should stay until another decision closes it, the way
   * a menu bar's menu does. While pinned, hovering other rows moves nothing.
   *
   * The owner sets it (on a row click, typically with `keepOpenOnRowClick`)
   * and clears it; `onUnpin` is the card asking for that, on Escape or a
   * click outside. Clearing it leaves the card closed until the pointer
   * reaches another row, like any dismissal.
   */
  pinnedKey?: string | null
  onUnpin?: () => void
  /** Moves the card down (or, negative, up) from the row's top edge, where it otherwise starts. */
  alignOffset?: number
  /**
   * Opens beside this element instead of the row, level with the row. For
   * keys that sit mid-card (a workflow's tiles): anchored to its own box, a
   * card would open over the tiles beside it rather than beside the column.
   */
  alignTo?: RefObject<HTMLElement | null>
  children: (rowKey: string, dismiss: () => void) => ReactNode | null
  className?: string
}) {
  const hasFinePointer = useHasFinePointer()
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  // What the pointer handlers read and write. They are registered once, so
  // they can't close over the state.
  const hoveredKeyRef = useRef<string | null>(null)
  // A click closes the card while the pointer is still on the row; without
  // this, one pixel of movement would raise it again.
  const dismissedKeyRef = useRef<string | null>(null)
  const anchorRef = useRef<{ getBoundingClientRect: () => DOMRect } | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  // The safe triangle's point: where the pointer last was on the card's row.
  const apexRef = useRef<Point | null>(null)
  const pointerRef = useRef<Point | null>(null)
  const restTimerRef = useRef<number | null>(null)
  const triangleRef = useRef<HTMLDivElement | null>(null)

  const getSafeTriangle = useCallback((): [Point, Point, Point] | null => {
    const content = contentRef.current
    const apex = apexRef.current
    if (!content || !apex) return null
    const rect = content.getBoundingClientRect()
    // Where Radix actually put it: a card with no room on its side flips.
    const opensRight = content.dataset.side !== "left"
    const nearX = opensRight ? rect.left : rect.right
    const apexX = apex.x + (opensRight ? -SAFE_TRIANGLE_APEX_BACKSET_PX : SAFE_TRIANGLE_APEX_BACKSET_PX)
    return [{ x: apexX, y: apex.y }, { x: nearX, y: rect.top }, { x: nearX, y: rect.bottom }]
  }, [])

  const drawSafeTriangle = useCallback(() => {
    const element = triangleRef.current
    if (!element) return
    const triangle = getSafeTriangle()
    if (!triangle) {
      element.style.display = "none"
      return
    }
    const left = Math.min(...triangle.map((point) => point.x))
    const top = Math.min(...triangle.map((point) => point.y))
    Object.assign(element.style, {
      display: "block",
      left: `${left}px`,
      top: `${top}px`,
      width: `${Math.max(...triangle.map((point) => point.x)) - left}px`,
      height: `${Math.max(...triangle.map((point) => point.y)) - top}px`,
      clipPath: `polygon(${triangle.map((point) => `${point.x - left}px ${point.y - top}px`).join(", ")})`,
    })
  }, [getSafeTriangle])

  const clearRestTimer = useCallback(() => {
    if (restTimerRef.current === null) return
    window.clearTimeout(restTimerRef.current)
    restTimerRef.current = null
  }, [])

  const pinnedKeyRef = useRef(pinnedKey)
  // Before the handlers can run again: they read the ref.
  useLayoutEffect(() => {
    const previous = pinnedKeyRef.current
    pinnedKeyRef.current = pinnedKey
    if (previous !== null && pinnedKey === null) {
      // Unpinned is closed, even with the pointer still on the row.
      dismissedKeyRef.current = previous
      hoveredKeyRef.current = null
      apexRef.current = null
      setHoveredKey(null)
    }
  }, [pinnedKey])
  /** The row the card is on: the pinned one, or failing that the hovered. */
  const shownKey = pinnedKey ?? hoveredKey

  const setHovered = useCallback((key: string | null) => {
    if (hoveredKeyRef.current === key) return
    hoveredKeyRef.current = key
    if (key === null) apexRef.current = null
    setHoveredKey(key)
  }, [])

  const dismiss = useCallback(() => {
    dismissedKeyRef.current = hoveredKeyRef.current
    setHovered(null)
  }, [setHovered])

  // Found in the DOM each render: rows remount (a section re-orders, a
  // refresh), and an anchor holding a detached row would float the card where
  // it was. A layout effect, so it lands before the popper reads the ref.
  useLayoutEffect(() => {
    const container = containerRef.current
    const row = shownKey && container
      ? container.querySelector<HTMLElement>(`[${rowAttribute}="${CSS.escape(shownKey)}"]`)
      : null
    const edge = alignTo?.current
    anchorRef.current = row && edge
      ? {
        getBoundingClientRect: () => {
          const rowRect = row.getBoundingClientRect()
          const edgeRect = edge.getBoundingClientRect()
          return DOMRect.fromRect({ x: edgeRect.left, y: rowRect.top, width: edgeRect.width, height: rowRect.height })
        },
      }
      : row
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container || !hasFinePointer) return

    function keyAt(target: EventTarget | null) {
      const row = target instanceof Element ? target.closest(`[${rowAttribute}]`) : null
      return row?.getAttribute(rowAttribute) ?? null
    }

    /** Gives the card to the row under the pointer, or closes it off a row. */
    function settle(key: string | null, point: Point) {
      clearRestTimer()
      if (key != null && key === dismissedKeyRef.current) return
      dismissedKeyRef.current = null
      apexRef.current = key === null ? null : point
      setHovered(key)
    }

    // `pointerover` for a row arriving under a still pointer (a scroll, a
    // re-order), `pointermove` for everything else: the triangle is left
    // between two moves on the same row, which fires no `pointerover`.
    function track(event: PointerEvent) {
      if (event.pointerType === "touch") return
      const point = { x: event.clientX, y: event.clientY }
      pointerRef.current = point
      // A pinned card is not the pointer's to move.
      if (pinnedKeyRef.current !== null) return
      const key = keyAt(event.target)

      if (key === hoveredKeyRef.current) {
        // Still on the card's row (or still on none): the triangle's point
        // follows the pointer.
        clearRestTimer()
        if (key !== null) apexRef.current = point
        drawSafeTriangle()
        return
      }

      const triangle = hoveredKeyRef.current === null ? null : getSafeTriangle()
      if (triangle && isInsideTriangle(point, ...triangle)) {
        // On its way to the card across another row. Held, unless it stops.
        clearRestTimer()
        restTimerRef.current = window.setTimeout(() => {
          restTimerRef.current = null
          const rested = pointerRef.current
          if (!rested) return
          const under = document.elementFromPoint(rested.x, rested.y)
          if (under && container!.contains(under)) settle(keyAt(under), rested)
        }, SAFE_TRIANGLE_REST_MS)
        return
      }

      settle(key, point)
      drawSafeTriangle()
    }

    // The triangle does not stop at the list's edge. From the last row, or
    // from any row toward a card that hangs below the list, the way to the
    // card leaves the list altogether, and the list hears nothing more. So
    // while the pointer is outside the list and inside the triangle it is
    // followed on the window instead, until it reaches the card, comes back
    // to the list, leaves the triangle, or stops.
    function trackOutside(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && (container!.contains(target) || contentRef.current?.contains(target))) {
        // Home: the list's own listeners, or the card's, take it from here.
        stopTrackingOutside()
        return
      }
      const point = { x: event.clientX, y: event.clientY }
      pointerRef.current = point
      const triangle = getSafeTriangle()
      if (!triangle || !isInsideTriangle(point, ...triangle)) {
        stopTrackingOutside()
        setHovered(null)
        return
      }
      clearRestTimer()
      restTimerRef.current = window.setTimeout(() => {
        restTimerRef.current = null
        stopTrackingOutside()
        setHovered(null)
      }, SAFE_TRIANGLE_REST_MS)
    }

    function stopTrackingOutside() {
      clearRestTimer()
      window.removeEventListener("pointermove", trackOutside)
    }

    // Straight across, the bridge on the card covers the gap, so the pointer
    // is already inside the card when the list reports it gone.
    function handlePointerLeave(event: PointerEvent) {
      clearRestTimer()
      if (pinnedKeyRef.current !== null) return
      const next = event.relatedTarget
      if (next instanceof Node && contentRef.current?.contains(next)) return
      const triangle = hoveredKeyRef.current === null ? null : getSafeTriangle()
      if (triangle && isInsideTriangle({ x: event.clientX, y: event.clientY }, ...triangle)) {
        window.addEventListener("pointermove", trackOutside)
        return
      }
      setHovered(null)
    }

    // A card left up while the window is in the background would be waiting
    // on the far side of a Cmd-Tab.
    function handleWindowBlur() {
      stopTrackingOutside()
      // A pinned card was put there on purpose, and waits.
      if (pinnedKeyRef.current === null) setHovered(null)
    }

    container.addEventListener("pointerover", track)
    container.addEventListener("pointermove", track)
    container.addEventListener("pointerleave", handlePointerLeave)
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      stopTrackingOutside()
      container.removeEventListener("pointerover", track)
      container.removeEventListener("pointermove", track)
      container.removeEventListener("pointerleave", handlePointerLeave)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }, [clearRestTimer, containerRef, drawSafeTriangle, getSafeTriangle, hasFinePointer, rowAttribute, setHovered])

  const handleContentPointerLeave = useCallback((event: { relatedTarget: EventTarget | null }) => {
    if (pinnedKeyRef.current !== null) return
    const next = event.relatedTarget
    // Back onto the list: its pointer listeners re-anchor the card in the
    // same move, so clearing here would only flicker it.
    if (next instanceof Node && containerRef.current?.contains(next)) return
    setHovered(null)
  }, [containerRef, setHovered])

  const content = hasFinePointer && shownKey ? children(shownKey, dismiss) : null
  const open = content != null

  // How much window there is from the card's resting top (level with its
  // row) down to the bottom edge, for a card whose contents scroll: see
  // `LIST_HOVER_CARD_ROOM_BELOW`. Measured when the card moves to a row, not
  // while it is up; a window resized under an open card is rare and the next
  // row corrects it.
  useLayoutEffect(() => {
    const content = contentRef.current
    const anchor = anchorRef.current
    if (!content || !anchor) return
    const room = window.innerHeight - (anchor.getBoundingClientRect().top + alignOffset) - COLLISION_PADDING_PX
    content.style.setProperty(LIST_HOVER_CARD_ROOM_BELOW, `${Math.max(0, room)}px`)
  }, [alignOffset, open, shownKey])

  // The card is placed a frame after it mounts, and again when the row under
  // it changes; the drawn triangle follows it there.
  useEffect(() => {
    if (!SHOW_SAFE_TRIANGLE) return
    drawSafeTriangle()
    const frame = window.requestAnimationFrame(drawSafeTriangle)
    return () => window.cancelAnimationFrame(frame)
  }, [drawSafeTriangle, shownKey, open])

  return (
    <PopoverPrimitive.Root
      open={open}
      // Only ever asked to close; pointing at a row is what opens it. Escape
      // and a click anywhere both arrive here, and both should leave the card
      // down until the pointer has moved on to another row.
      onOpenChange={(nextOpen) => {
        if (nextOpen) return
        if (pinnedKey !== null) onUnpin?.()
        else dismiss()
      }}
    >
      {/* Anchored to the row's element instead of wrapping it: the card
          belongs to whichever row is under the pointer, and that changes
          without any of them re-rendering. Radix types the ref as always
          holding a measurable, but is happy with an empty one, which is what
          "no row is hovered" is. */}
      <PopoverPrimitive.Anchor
        virtualRef={anchorRef as ComponentPropsWithoutRef<typeof PopoverPrimitive.Anchor>["virtualRef"]}
      />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={contentRef}
          side={side}
          // Top-aligned with the row: centred, a tall card floats above the
          // row it describes and leaves you tracing back to which.
          align="start"
          sideOffset={sideOffset}
          alignOffset={alignOffset}
          collisionPadding={COLLISION_PADDING_PX}
          // A peek, not a destination: never pulls focus in or throws it out.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onPointerLeave={handleContentPointerLeave}
          onInteractOutside={(event) => {
            const target = event.target
            if (keepOpenOnRowClick && target instanceof Element && target.closest(`[${rowAttribute}]`)
              && containerRef.current?.contains(target)) {
              event.preventDefault()
            }
          }}
          className={cn(
            HOVER_CARD_SURFACE_CLASSNAME,
            // The bridge. Wider than the 15px `sideOffset`, so it overlaps
            // the row's last pixels and no subpixel gap drops the pointer on
            // its way across. Full height, since a card near the screen's
            // bottom shifts up and its rows must stay reachable.
            "relative before:absolute before:inset-y-0 before:w-5 before:content-['']",
            "data-[side=right]:before:-left-5 data-[side=left]:before:-right-5",
            // Grows from the row it describes rather than from its own
            // centre (the surface's zoom-in-95 otherwise pivots there).
            "origin-(--radix-popover-content-transform-origin)",
            className,
          )}
        >
          {content}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
      {SHOW_SAFE_TRIANGLE && open ? createPortal(
        // Over everything, the sidebar included: it is there to be seen.
        <div ref={triangleRef} aria-hidden className="pointer-events-none fixed z-[9999] hidden bg-red-500/50" />,
        document.body,
      ) : null}
    </PopoverPrimitive.Root>
  )
}
