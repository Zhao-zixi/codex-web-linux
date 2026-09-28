import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { formatDuration, formatPromptTimestamp } from "../../components/messages/ResultMessage"
import { toMessagePreview } from "../../../shared/message-preview"
import type { ChatJumpRole } from "../../lib/chat-navigation"
import { TurnCardMessage, TurnCardTimingRow } from "../../components/ui/turn-card"
import {
  getMagnifyFalloff,
  getMinimapCapacity,
  getTranscriptGutterWidth,
  isTurnInView,
  selectVisibleTurns,
  type TranscriptTurn,
} from "./transcriptTurns"

/** Transcript column geometry the strip lives beside. */
const TRANSCRIPT_COLUMN_MAX_WIDTH_PX = 800
const TRANSCRIPT_COLUMN_PADDING_PX = 24

/** Narrowest pane, padding included, the strip earns its place beside. */
const MIN_TRANSCRIPT_WIDTH_PX = 855

/**
 * The gutter that leaves either side of the column — a hair under what a fully
 * magnified tick wants, so at the low end the swell just grazes the column edge.
 */
const MIN_GUTTER_PX = (MIN_TRANSCRIPT_WIDTH_PX - TRANSCRIPT_COLUMN_MAX_WIDTH_PX) / 2

/** Inset from the left edge of the chat pane. */
const STRIP_INSET_PX = 15

/**
 * Tick geometry is proportioned off one basis value: spacing is its golden
 * minor, and a tick under the cursor grows by the magnification scale.
 */
const GOLDEN_MINOR = 0.618
const MAGNIFY_SCALE = 2
/**
 * The number the rest of the geometry is proportioned from, so retuning the
 * strip stays a single value. Never rendered as a width itself — every tick
 * sits at the resting width until the cursor's swell reaches it.
 */
const TICK_SCALE_BASIS_PX = 13
/** Width of every tick outside the swell, hovered or not. */
const TICK_RESTING_WIDTH_PX = 10
/** The basis's golden minor, tightened a pixel by eye. */
const TICK_PITCH_PX = TICK_SCALE_BASIS_PX * GOLDEN_MINOR - 1
const TICK_MAX_WIDTH_PX = TICK_SCALE_BASIS_PX * MAGNIFY_SCALE

/** Quick while the cursor is on the strip, slower settling back once it leaves. */
const SIZE_ENTER_DURATION_MS = 100
const SIZE_EXIT_DURATION_MS = 200
const OPACITY_DURATION_MS = 150
const TICK_BASE_HEIGHT_PX = 2
const TICK_MAX_HEIGHT_PX = 3

/**
 * Tick opacity is a resting value plus one exception.
 *
 * At rest the strip is near-invisible, brighter for the turns on screen. Once
 * the cursor picks out a tick, that one goes fully opaque — the same one the
 * hover card describes — and every other tick drops to the floor, including
 * the ones on screen: while you are pointing at something, where you are
 * reading is no longer the question being asked.
 *
 * Opacity is deliberately a step rather than a gradient like size is. Two
 * competing highlights would make it ambiguous which tick the card belongs to.
 */
const TICK_OPACITY_OFF_SCREEN = 0.15
/** Roughly 5.3x the floor — the contrast that carries "you are here". */
const TICK_OPACITY_ON_SCREEN = 0.8
const TICK_OPACITY_FOCUSED = 1
/**
 * How many neighbours either side of the cursor swell. The radius is derived
 * from the pitch so the effect keeps its shape whatever the spacing, and capped
 * by the tick count so a short strip does not get a radius reaching past both
 * of its ends — which would magnify every tick at once and read as a wobble
 * rather than a dock.
 */
const MAGNIFY_NEIGHBOURS = 4
/** Upper bound on ticks regardless of window height — beyond this it reads as noise. */
const MAX_TICKS = 40

/** Pointer target width, generous so the hairline ticks are easy to hit. */
const HIT_WIDTH_PX = 72
/** Vertical slop so hovering just past the end tick still magnifies it. */
const HIT_PADDING_Y_PX = 20

const CARD_WIDTH_PX = 320
const CARD_GAP_PX = 16
/**
 * Roughly how tall the card gets, used only to keep it inside the pane.
 *
 * Not a cap on the card itself: its height is already bounded by the line
 * clamps (5 lines per message, plus one meta row), and capping it as well
 * only risks shearing off the bottom padding when the content runs long.
 */
const CARD_ESTIMATED_HEIGHT_PX = 252

interface TranscriptMinimapProps {
  turns: TranscriptTurn[]
  /** LegendList's rendered row range, used to decide which ticks read as "here". */
  visibleStart: number
  visibleEnd: number
  /** Whether the transcript can scroll at all — a map of one screen is noise. */
  transcriptOverflows: boolean
  /** Top of the transcript area (below the floating navbar). */
  topPx: number
  /** Bottom of the transcript area (above the floating input dock). */
  bottomPx: number
  /** Width of the scroll pane, used to decide whether there is room at all. */
  containerWidthPx: number
  /** Jump to one end of a turn — its prompt, or where its answer landed. */
  onSelectTurn: (turn: TranscriptTurn, role: ChatJumpRole) => void
}

/**
 * A vertical strip of ticks — one per turn — sitting in the dead gutter left of
 * the transcript column. Ticks for turns currently on screen read bright, the
 * rest stay faint; hovering magnifies neighbours dock-style and surfaces the
 * question with the answer it landed on.
 *
 * Hidden whenever the gutter is too narrow to hold it, and on coarse pointers,
 * where a hover-driven affordance has nothing to offer.
 */
export const TranscriptMinimap = memo(function TranscriptMinimap({
  turns,
  visibleStart,
  visibleEnd,
  transcriptOverflows,
  topPx,
  bottomPx,
  containerWidthPx,
  onSelectTurn,
}: TranscriptMinimapProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const [wrapperHeight, setWrapperHeight] = useState(0)
  const [pointerY, setPointerY] = useState<number | null>(null)
  /**
   * The turn the card keeps describing once the cursor has walked onto the card
   * itself and off the strip that chose it.
   *
   * Held as the turn rather than an index so the hold survives the tick list
   * changing under it: a turn that is no longer on the strip has no tick to sit
   * beside, and the card drops rather than pointing at a neighbour.
   */
  const [heldTurn, setHeldTurn] = useState<TranscriptTurn | null>(null)
  const hasFinePointer = useHasFinePointer()

  useLayoutEffect(() => {
    const element = wrapperRef.current
    if (!element) return

    const updateHeight = () => {
      const next = element.clientHeight
      setWrapperHeight((current) => (Math.abs(current - next) < 1 ? current : next))
    }

    const observer = new ResizeObserver(updateHeight)
    observer.observe(element)
    updateHeight()
    return () => observer.disconnect()
  }, [])

  const gutterWidth = getTranscriptGutterWidth(
    containerWidthPx,
    TRANSCRIPT_COLUMN_MAX_WIDTH_PX,
    TRANSCRIPT_COLUMN_PADDING_PX,
  )
  const hasRoom = gutterWidth >= MIN_GUTTER_PX

  const capacity = getMinimapCapacity(
    wrapperHeight - HIT_PADDING_Y_PX * 2,
    TICK_PITCH_PX,
    MAX_TICKS,
  )
  const ticks = useMemo(() => selectVisibleTurns(turns, capacity), [capacity, turns])
  const magnifyRadiusPx = TICK_PITCH_PX * Math.min(MAGNIFY_NEIGHBOURS, ticks.length)

  // Pointer samples land far faster than paint; coalesce to one per frame.
  const pointerFrameRef = useRef<number | null>(null)
  const cancelPointerFrame = useCallback(() => {
    if (pointerFrameRef.current !== null) {
      window.cancelAnimationFrame(pointerFrameRef.current)
      pointerFrameRef.current = null
    }
  }, [])
  useEffect(() => cancelPointerFrame, [cancelPointerFrame])

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const offsetY = event.clientY - bounds.top
    cancelPointerFrame()
    // Back on the strip, so the strip is choosing again. Functional so a resting
    // hold is the only thing this re-renders for, not every sample.
    setHeldTurn((current) => (current ? null : current))
    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null
      setPointerY(offsetY)
    })
  }, [cancelPointerFrame])

  /** The turn under the cursor, readable from an event handler a render later. */
  const focusedTurnRef = useRef<TranscriptTurn | null>(null)

  const handlePointerLeave = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    cancelPointerFrame()
    // Crossing onto the card is not leaving. The card is a click target now, so
    // the turn it describes has to survive the walk over to it — but only for
    // that one exit: `relatedTarget` names what the pointer actually entered,
    // so leaving the strip any other way still clears, and no card is ever
    // stranded over the transcript waiting for a pointerleave that can't come.
    //
    // The walk needs no bridge because the card already overlaps the strip's
    // right edge, so there is no dead gap between them to fall into.
    const entered = event.relatedTarget
    const enteredCard = entered instanceof Node && (cardRef.current?.contains(entered) ?? false)
    setHeldTurn(enteredCard ? focusedTurnRef.current : null)
    setPointerY(null)
  }, [cancelPointerFrame])

  const handleCardPointerLeave = useCallback(() => setHeldTurn(null), [])

  // Dismiss on the way out: the pointer is still over the card afterwards, and
  // a card left standing would hang over the transcript it just took you to.
  const handleSelect = useCallback((turn: TranscriptTurn, role: ChatJumpRole) => {
    cancelPointerFrame()
    setHeldTurn(null)
    setPointerY(null)
    onSelectTurn(turn, role)
  }, [cancelPointerFrame, onSelectTurn])

  // Reset on anything that can move ticks out from under a resting cursor.
  useEffect(() => {
    setPointerY(null)
    setHeldTurn(null)
  }, [capacity, hasRoom, transcriptOverflows])

  /**
   * Whether the strip earns its place. Scrollable content is the test, not the
   * turn count: one turn long enough to scroll through still has a top to jump
   * back to, and its tick still tracks where in it you are.
   *
   * Note this only gates the strip's *contents*: the wrapper below always
   * renders, because it is what the ResizeObserver measures, and remounting it
   * whenever a resize crosses the threshold would cost a frame of stale height
   * every time the strip reappears.
   */
  const isVisible = hasFinePointer && hasRoom && transcriptOverflows && ticks.length > 0

  const stripHeight = ticks.length * TICK_PITCH_PX
  const stripTop = Math.max(0, (wrapperHeight - stripHeight) / 2)
  const hitTop = stripTop - HIT_PADDING_Y_PX

  const tickCenterY = (index: number) => HIT_PADDING_Y_PX + index * TICK_PITCH_PX + TICK_PITCH_PX / 2

  let focusedIndex = -1
  let focusedDistance = Number.POSITIVE_INFINITY
  if (isVisible && pointerY !== null) {
    ticks.forEach((_, index) => {
      const distance = Math.abs(pointerY - tickCenterY(index))
      if (distance < focusedDistance) {
        focusedDistance = distance
        focusedIndex = index
      }
    })
    if (focusedDistance > magnifyRadiusPx) focusedIndex = -1
  }

  // Quick while the cursor is engaged, gentler once it has left the strip.
  const sizeDurationMs = focusedIndex >= 0 ? SIZE_ENTER_DURATION_MS : SIZE_EXIT_DURATION_MS

  const focusedTurn = focusedIndex >= 0 ? ticks[focusedIndex] : null
  useEffect(() => {
    focusedTurnRef.current = focusedTurn
  }, [focusedTurn])

  /**
   * The tick the card belongs to — chosen by the cursor while it's on the
   * strip, then held while the cursor is on the card. Everything the card and
   * the highlight read comes from this one index, so a held card keeps both its
   * position and its tick instead of sliding to the top with nothing lit.
   */
  // Gated on `isVisible` like the cursor-driven index already is: a hold is only
  // as alive as the strip that granted it, so a strip that goes away (the pane
  // narrows, the transcript stops overflowing) takes its card with it.
  const heldIndex = isVisible && heldTurn ? ticks.findIndex((tick) => tick.id === heldTurn.id) : -1
  const activeIndex = focusedIndex >= 0 ? focusedIndex : heldIndex
  const activeTurn = activeIndex >= 0 ? ticks[activeIndex] : null

  const cardDuration = activeTurn && activeTurn.durationMs !== null
    ? formatDuration(activeTurn.durationMs)
    : null
  const cardTimestamp = activeTurn?.timestamp ? formatPromptTimestamp(activeTurn.timestamp) : null
  const cardCenterY = activeIndex >= 0
    ? clamp(
        hitTop + tickCenterY(activeIndex),
        CARD_ESTIMATED_HEIGHT_PX / 2,
        Math.max(CARD_ESTIMATED_HEIGHT_PX / 2, wrapperHeight - CARD_ESTIMATED_HEIGHT_PX / 2),
      )
    : 0

  return (
    <div
      ref={wrapperRef}
      className="pointer-events-none absolute left-0 z-10"
      style={{ top: topPx, bottom: bottomPx, width: HIT_WIDTH_PX + CARD_GAP_PX + CARD_WIDTH_PX }}
    >
      {!isVisible ? null : (
      <div
        className="pointer-events-auto absolute left-0"
        style={{ top: hitTop, height: stripHeight + HIT_PADDING_Y_PX * 2, width: HIT_WIDTH_PX }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
      >
        {ticks.map((turn, index) => {
          const centerY = tickCenterY(index)
          const falloff = pointerY === null ? 0 : getMagnifyFalloff(pointerY - centerY, magnifyRadiusPx)
          // The in-view highlight only applies while nothing is focused: once
          // a tick is picked out, every other tick sits at the floor.
          const isGrowing = falloff > 0

          const inView = activeIndex < 0 && isTurnInView(turn, visibleStart, visibleEnd)
          const opacity = index === activeIndex
            ? TICK_OPACITY_FOCUSED
            : inView ? TICK_OPACITY_ON_SCREEN : TICK_OPACITY_OFF_SCREEN

          return (
            // The bar is a hairline, so the button is a full-pitch invisible
            // row and the bar is painted inside it — otherwise the target
            // would be 2px tall and effectively unclickable.
            <button
              key={turn.id}
              type="button"
              onClick={() => handleSelect(turn, "prompt")}
              aria-label={`Jump to: ${toMessagePreview(turn.prompt).slice(0, 80)}`}
              className="absolute left-0 flex cursor-pointer items-center bg-transparent p-0"
              style={{
                top: centerY,
                transform: "translateY(-50%)",
                width: HIT_WIDTH_PX,
                height: TICK_PITCH_PX,
              }}
            >
              {/* Deliberately uniform in colour: a tick's only job is to show
                  where a turn sits and whether it is on screen. Tinting
                  failures would make the strip a status display and compete
                  with the in-view contrast that carries the actual meaning. */}
              <span
                className="absolute rounded-full bg-foreground"
                style={{
                  left: STRIP_INSET_PX,
                  width: TICK_RESTING_WIDTH_PX
                    + (TICK_MAX_WIDTH_PX - TICK_RESTING_WIDTH_PX) * falloff,
                  height: TICK_BASE_HEIGHT_PX + (TICK_MAX_HEIGHT_PX - TICK_BASE_HEIGHT_PX) * falloff,
                  opacity,
                  // A tick inside the swell tracks the cursor, so its size must
                  // not tween — that is what made the dock feel rubbery. One
                  // that has just left the swell eases back instead. Opacity
                  // always eases: it steps between fixed values, and an
                  // untweened step reads as a flicker as the focus moves.
                  transition: isGrowing
                    ? `opacity ${OPACITY_DURATION_MS}ms ease-out`
                    : `width ${sizeDurationMs}ms ease-out,`
                      + ` height ${sizeDurationMs}ms ease-out,`
                      + ` opacity ${OPACITY_DURATION_MS}ms ease-out`,
                }}
              />
            </button>
          )
        })}
      </div>
      )}

      {activeTurn ? (
        // Interactive, and so overlapping the strip's right edge by design —
        // that overlap is what lets the cursor reach the card without crossing
        // dead space (see `handlePointerLeave`). `px-1.5` rather than the
        // `px-3` this looks like: the other half of the inset lives on each
        // row, so a message's hover fill can run wider than its text.
        <div
          ref={cardRef}
          onPointerLeave={handleCardPointerLeave}
          className="pointer-events-auto absolute animate-fade-in rounded-lg border border-border bg-popover/95 px-1.5 py-2 shadow-xl backdrop-blur-sm transition-[top] duration-150 ease-out"
          style={{
            left: STRIP_INSET_PX + TICK_MAX_WIDTH_PX + CARD_GAP_PX,
            top: cardCenterY,
            width: CARD_WIDTH_PX,
            transform: "translateY(-50%)",
          }}
        >
          {/* The two messages are the two places in this turn you'd want to be,
              so both are targets: the prompt lands on the question, the reply
              on where the answer ended up. Same as the sidebar's chat card —
              which is this card, applied to the other list of turns you scan. */}
          <div className="space-y-1">
            <TurnCardMessage
              className="line-clamp-5 text-sm font-medium text-popover-foreground"
              label="Jump to this prompt"
              onSelect={() => handleSelect(activeTurn, "prompt")}
            >
              {toMessagePreview(activeTurn.prompt) || "Empty message"}
            </TurnCardMessage>
            {activeTurn.error ? (
              // Not put through the preview pass: a failure is a diagnostic the
              // provider wrote, not authored markdown, and its punctuation is
              // more likely to be part of the message than markup.
              //
              // Clickable on the same footing as a reply: it sits in the reply's
              // slot and it's the turn's outcome, so it lands where the turn
              // ended — which is exactly where you'd go to read the failure.
              <TurnCardMessage
                className="line-clamp-5 text-sm text-destructive"
                label="Jump to this failure"
                onSelect={() => handleSelect(activeTurn, "reply")}
              >
                {activeTurn.error}
              </TurnCardMessage>
            ) : activeTurn.response ? (
              <TurnCardMessage
                className="line-clamp-5 text-sm text-muted-foreground"
                label="Jump to this reply"
                onSelect={() => handleSelect(activeTurn, "reply")}
              >
                {toMessagePreview(activeTurn.response)}
              </TurnCardMessage>
            ) : null}
          </div>
          <TurnCardTimingRow
            detail={cardDuration}
            timestamp={cardTimestamp}
            // What the sidebar's card spends this slot on the harness for: the
            // one fact about the turn that the two lines above it don't carry.
            // A prompt and a closing sentence look the same whether the agent
            // answered in one breath or ran forty tools to get there.
            leading={activeTurn.agentMessageCount > 0 ? formatAgentMessageCount(activeTurn.agentMessageCount) : null}
          />
        </div>
      ) : null}
    </div>
  )
})

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

/** "1 message" / "12 messages" — the agent's own text and tool calls. */
function formatAgentMessageCount(count: number) {
  return `${count} message${count === 1 ? "" : "s"}`
}

/**
 * Whether the device has a hover-capable, precise pointer. The strip is driven
 * entirely by hover, so on touch it is dead weight over the transcript.
 */
function useHasFinePointer() {
  const [hasFinePointer, setHasFinePointer] = useState(false)

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return
    const query = window.matchMedia("(hover: hover) and (pointer: fine)")
    const update = () => setHasFinePointer(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return hasFinePointer
}
