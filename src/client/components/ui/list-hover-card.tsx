import { type ComponentPropsWithoutRef, type CSSProperties, type ReactNode, type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
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
  "z-50 w-80 rounded-lg border border-border bg-popover/95 px-1.5 py-2 text-xs text-popover-foreground shadow-xl outline-none backdrop-blur-sm animate-in fade-in-0 zoom-in-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:hidden"

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
 *
 * Read it with a fallback (`var(…, 60vh)`). It is set a commit after the card
 * mounts, and without one that first layout has no cap at all.
 */
export const LIST_HOVER_CARD_ROOM_BELOW = "--list-hover-card-room-below"

/**
 * Set on the row a card is up for, for as long as it is up.
 *
 * A row's hover style follows the pointer, and the pointer leaves the row to
 * reach its card: across other rows inside the safe triangle, then onto the
 * card itself. Without this the row goes plain the moment it is left, and a
 * card stands there belonging to nothing. Rows style it alongside `:hover`
 * (`data-[hover-card-open]:…`).
 */
export const HOVER_CARD_OPEN_ATTRIBUTE = "data-hover-card-open"

/** A Radix menu (a row's right-click menu) that is up. */
const OPEN_MENU_SELECTOR = "[data-radix-menu-content][data-state='open']"
/** Marks every hover card's element, so one can tell the pointer is over another. */
const LIST_HOVER_CARD_ATTRIBUTE = "data-list-hover-card"

/** How soon after mounting a pointer found on a row is taken to have been there all along. */
const HELD_ON_MOUNT_MS = 1000

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
  holdRowUnderPointerOnMount = false,
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
  /**
   * Which side of the row the card opens on: away from the window's edge for
   * a list down a side, beneath for a row of things along a bar.
   */
  side: "left" | "right" | "bottom"
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
   * Treats the row the pointer is already on when this mounts as dismissed,
   * until the pointer leaves it. For a list that can be rebuilt by a click
   * on one of its own rows (the chat tabs: opening a chat in another project
   * rebuilds the navbar they are in). The rebuilt list is a new card that
   * never saw the click, and would otherwise raise itself over the row that
   * was just pressed.
   */
  holdRowUnderPointerOnMount?: boolean
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
  // How far the bridge laps onto the row, past the gap. Beside a list it
  // lands in the row's end padding, where a few pixels close any subpixel
  // seam and cover nothing you would click. Beneath a bar it would lie
  // across the bottom of the thing itself (a tab), so there it is a hairline.
  const bridgeOverlap = side === "bottom" ? 1 : 5
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
  // The card's element as state too, for the one effect that has to run when
  // it appears: Radix mounts the card through a portal, a commit after the
  // render that opened it, so on that render the ref is still empty.
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null)
  const setContent = useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
    setContentNode(node)
  }, [])
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
    const placed = content.dataset.side
    if (placed === "bottom" || placed === "top") {
      // Above or below its row: the card's near edge runs side to side.
      const opensDown = placed === "bottom"
      const nearY = opensDown ? rect.top : rect.bottom
      const apexY = apex.y + (opensDown ? -SAFE_TRIANGLE_APEX_BACKSET_PX : SAFE_TRIANGLE_APEX_BACKSET_PX)
      return [{ x: apex.x, y: apexY }, { x: rect.left, y: nearY }, { x: rect.right, y: nearY }]
    }
    const opensRight = placed !== "left"
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

  const holdFirstRowRef = useRef(holdRowUnderPointerOnMount)
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
    // Only a card that is up has a row to hold closed. One click asks twice
    // (the press outside the card, then focus leaving it), and the second
    // ask, with the card already down, used to overwrite the held row with
    // nothing: the hold was gone, and the next pixel of movement raised the
    // card again. Open, closed, open.
    if (hoveredKeyRef.current !== null) dismissedKeyRef.current = hoveredKeyRef.current
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

    const mountedAt = performance.now()

    function keyAt(target: EventTarget | null) {
      const row = target instanceof Element ? target.closest(`[${rowAttribute}]`) : null
      return row?.getAttribute(rowAttribute) ?? null
    }

    /** Gives the card to the row under the pointer, or closes it off a row. */
    function settle(key: string | null, point: Point) {
      clearRestTimer()
      if (key != null && key === dismissedKeyRef.current) return
      apexRef.current = key === null ? null : point
      setHovered(key)
    }

    // A dismissal holds for as long as the pointer is still on the row it
    // was made on, and that is judged by where the pointer is, against the
    // row's box, on every move anywhere on the page. Not by which element an
    // event names, and not by enter and leave events: a click often rebuilds
    // what is under the pointer (a tab becoming the open one), and the
    // browser then reports elements entered and left that the pointer never
    // moved across. Each of those used to end the hold on the very click
    // that began it, and the card came straight back.
    function releaseDismissalIfLeft(event: PointerEvent) {
      const dismissed = dismissedKeyRef.current
      if (dismissed === null) return
      const row = container!.querySelector(`[${rowAttribute}="${CSS.escape(dismissed)}"]`)
      const rect = row?.getBoundingClientRect()
      const stillOnRow = rect !== undefined
        && event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom
      if (!stillOnRow) dismissedKeyRef.current = null
    }

    // A press on a row dismisses its card, whoever else notices the press:
    // the row was acted on, and its card should not be up over the result.
    function handlePointerDown(event: PointerEvent) {
      const key = keyAt(event.target)
      if (key === null || pinnedKeyRef.current !== null) return
      dismissedKeyRef.current = key
    }

    // `pointerover` for a row arriving under a still pointer (a scroll, a
    // re-order), `pointermove` for everything else: the triangle is left
    // between two moves on the same row, which fires no `pointerover`.
    function track(event: PointerEvent) {
      if (event.pointerType === "touch") return
      const point = { x: event.clientX, y: event.clientY }
      pointerRef.current = point
      if (holdFirstRowRef.current) {
        // The first the list hears of the pointer: where it already was,
        // if that is soon after mounting. Later, it is a pointer arriving.
        holdFirstRowRef.current = false
        const key = keyAt(event.target)
        if (key !== null && performance.now() - mountedAt < HELD_ON_MOUNT_MS) {
          dismissedKeyRef.current = key
          return
        }
      }
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

    document.addEventListener("pointermove", releaseDismissalIfLeft, true)
    container.addEventListener("pointerdown", handlePointerDown, true)
    container.addEventListener("pointerover", track)
    container.addEventListener("pointermove", track)
    container.addEventListener("pointerleave", handlePointerLeave)
    window.addEventListener("blur", handleWindowBlur)
    return () => {
      stopTrackingOutside()
      document.removeEventListener("pointermove", releaseDismissalIfLeft, true)
      container.removeEventListener("pointerdown", handlePointerDown, true)
      container.removeEventListener("pointerover", track)
      container.removeEventListener("pointermove", track)
      container.removeEventListener("pointerleave", handlePointerLeave)
      window.removeEventListener("blur", handleWindowBlur)
    }
  }, [clearRestTimer, containerRef, drawSafeTriangle, getSafeTriangle, hasFinePointer, rowAttribute, setHovered])

  // A right-click menu opened from inside the card makes everything under it
  // dead to the pointer while it is up (Radix's menus do), which the browser
  // reports as the pointer leaving the card. It hasn't: the menu belongs to a
  // row in the card, and closing the card would take the menu with it. So
  // that leave is held, and looked at again on the first move after the menu
  // has gone, when where the pointer really is can be told.
  const menuHoldRef = useRef<((event: PointerEvent) => void) | null>(null)
  const releaseMenuHold = useCallback(() => {
    if (!menuHoldRef.current) return
    window.removeEventListener("pointermove", menuHoldRef.current)
    menuHoldRef.current = null
  }, [])
  useEffect(() => releaseMenuHold, [releaseMenuHold])

  const handleContentPointerLeave = useCallback((event: { relatedTarget: EventTarget | null }) => {
    if (pinnedKeyRef.current !== null) return
    const next = event.relatedTarget
    // Back onto the list: its pointer listeners re-anchor the card in the
    // same move, so clearing here would only flicker it.
    if (next instanceof Node && containerRef.current?.contains(next)) return
    if (document.querySelector(OPEN_MENU_SELECTOR)) {
      if (menuHoldRef.current) return
      const recheck = (moveEvent: PointerEvent) => {
        if (document.querySelector(OPEN_MENU_SELECTOR)) return
        releaseMenuHold()
        const target = moveEvent.target
        // Any hover card counts: one nested in this card is outside its
        // element, but not outside it.
        const stillOver = target instanceof Element
          && (containerRef.current?.contains(target) || target.closest(`[${LIST_HOVER_CARD_ATTRIBUTE}]`))
        if (!stillOver && pinnedKeyRef.current === null) setHovered(null)
      }
      menuHoldRef.current = recheck
      window.addEventListener("pointermove", recheck)
      return
    }
    setHovered(null)
  }, [containerRef, releaseMenuHold, setHovered])

  const content = hasFinePointer && shownKey ? children(shownKey, dismiss) : null
  const open = content != null

  // The card's row is marked while the card is up (`HOVER_CARD_OPEN_ATTRIBUTE`).
  // By attribute on the element, not through React: the rows are the owner's,
  // memoized, and know nothing of which one is hovered.
  useLayoutEffect(() => {
    if (!open || !shownKey) return
    const row = containerRef.current?.querySelector<HTMLElement>(`[${rowAttribute}="${CSS.escape(shownKey)}"]`)
    if (!row) return
    row.setAttribute(HOVER_CARD_OPEN_ATTRIBUTE, "")
    return () => row.removeAttribute(HOVER_CARD_OPEN_ATTRIBUTE)
  }, [containerRef, open, rowAttribute, shownKey])

  // How much window there is from the card's resting top (level with its
  // row) down to the bottom edge, for a card whose contents scroll: see
  // `LIST_HOVER_CARD_ROOM_BELOW`. Measured when the card moves to a row, not
  // while it is up; a window resized under an open card is rare and the next
  // row corrects it.
  //
  // Keyed on the card's element as well as its row: the first time a card
  // opens there is no element yet when this runs for the row (see
  // `contentNode`). Missing that left the variable unset on every first
  // open, and a list capped by an unset variable is not capped at all: a
  // channel with hundreds of chats laid every one of them out, off the
  // bottom of the window.
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!contentNode || !anchor) return
    const room = window.innerHeight - (anchor.getBoundingClientRect().top + alignOffset) - COLLISION_PADDING_PX
    contentNode.style.setProperty(LIST_HOVER_CARD_ROOM_BELOW, `${Math.max(0, room)}px`)
  }, [alignOffset, contentNode, shownKey])

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
          ref={setContent}
          {...{ [LIST_HOVER_CARD_ATTRIBUTE]: "" }}
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
          style={{ "--bridge": `${Math.max(0, sideOffset) + bridgeOverlap}px` } as CSSProperties}
          onInteractOutside={(event) => {
            const target = event.target
            if (keepOpenOnRowClick && target instanceof Element && target.closest(`[${rowAttribute}]`)
              && containerRef.current?.contains(target)) {
              event.preventDefault()
            }
          }}
          className={cn(
            HOVER_CARD_SURFACE_CLASSNAME,
            // The bridge: an invisible part of the card over the gap to the
            // row, overlapping the row's edge so no subpixel seam drops the
            // pointer on its way across. It runs the card's full length,
            // since a card near the screen's edge is shifted to fit and its
            // rows must stay reachable.
            // Beside its row it is a strip down the card's near side; above
            // or below, one along it. As deep as the gap and a little more
            // (`--bridge`), and no deeper: it lies over the row, and what it
            // covers takes the card's clicks, not the row's.
            "relative before:absolute before:content-['']",
            "data-[side=right]:before:inset-y-0 data-[side=right]:before:left-[calc(var(--bridge)*-1)] data-[side=right]:before:w-(--bridge)",
            "data-[side=left]:before:inset-y-0 data-[side=left]:before:right-[calc(var(--bridge)*-1)] data-[side=left]:before:w-(--bridge)",
            "data-[side=bottom]:before:inset-x-0 data-[side=bottom]:before:top-[calc(var(--bridge)*-1)] data-[side=bottom]:before:h-(--bridge)",
            "data-[side=top]:before:inset-x-0 data-[side=top]:before:bottom-[calc(var(--bridge)*-1)] data-[side=top]:before:h-(--bridge)",
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
