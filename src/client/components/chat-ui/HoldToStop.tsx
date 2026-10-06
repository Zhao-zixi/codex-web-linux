import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { createHoldToConfirm, type HoldClock } from "../../lib/hold-to-confirm"

/**
 * Stopping a turn with Escape takes a hold, not a press: Escape is under the
 * finger for a dozen other things (closing a menu, the viewer's pane, leaving
 * focus mode), and one of those landing on a running turn threw its work
 * away. Held for a second and a half it is unmistakably meant.
 *
 * While the key is down a ring draws round the composer's Stop button, and
 * the turn stops when it closes. The ring is the hold made visible: without
 * it a held key is a wait with no end in sight, and a tap is a key that
 * stopped working. It is the one thing Escape animates, and it is there for
 * the state it shows, not as an effect: a deliberate, occasional act, which
 * is where a key gets to move something.
 *
 * The timing is the hold-to-confirm pattern. The fill is linear over the
 * whole hold, because it is progress and progress does not ease. Letting go
 * runs it back in 200ms on the app's strong ease-out: slow where the user is
 * deciding, fast where the interface is answering.
 *
 * Clicking Stop is unchanged, and immediate. A click on that button is
 * already as deliberate as a hold.
 */

export const HOLD_TO_STOP_MS = 1500
/** The ring's way back when the key is let go. Matches the transition on the ring below. */
const RELEASE_MS = 200
/** How long the hint outlasts a tap, to be read. */
const HINT_LINGER_MS = 1600
/**
 * How long a closed ring waits for the turn to be seen to stop before giving
 * up on it. The interrupt is a round trip; one that failed, or a turn the
 * server kept running, must not leave a full ring up for good.
 */
const CONFIRMED_LINGER_MS = 2500

const browserClock: HoldClock = {
  now: () => performance.now(),
  requestFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
}

/**
 * - `holding`: the key is down and the ring is drawing.
 * - `released`: let go early. The ring has gone back; the hint stays a moment.
 * - `confirmed`: held to the end. The ring stays closed until the turn stops.
 */
type HoldPhase = "idle" | "holding" | "released" | "confirmed"

export interface HoldToStop {
  /** The ring's drawn arc, written to directly while a hold runs. */
  arcRef: RefObject<SVGCircleElement | null>
  /** Whether the ring is on screen at all. */
  ringShown: boolean
  /** Whether to say that Escape has to be held. */
  hintShown: boolean
  /** The ring is up because of a hold, drawing or closed. */
  engaged: boolean
  /**
   * The first keydown of an Escape. `origin` is the field it was pressed in:
   * the hold is given up if focus leaves it.
   */
  press: (origin: HTMLElement) => void
}

export function useHoldToStop({ enabled, onConfirm }: {
  /** There is a turn to stop. Going false ends any hold: there is nothing left to hold for. */
  enabled: boolean
  onConfirm: () => void
}): HoldToStop {
  const arcRef = useRef<SVGCircleElement | null>(null)
  const [phase, setPhase] = useState<HoldPhase>("idle")
  const [ringShown, setRingShown] = useState(false)
  const onConfirmRef = useRef(onConfirm)
  onConfirmRef.current = onConfirm
  const detachRef = useRef<(() => void) | null>(null)
  const timerRef = useRef<number | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])
  const detach = useCallback(() => {
    detachRef.current?.()
    detachRef.current = null
  }, [])

  /** The ring back to empty: over the release transition, or at once. */
  const emptyRing = useCallback((instant: boolean) => {
    const arc = arcRef.current
    if (!arc) return
    // Inline `none` is what a hold draws under; cleared, the class's
    // transition takes over and runs back from the value last drawn.
    arc.style.transition = instant ? "none" : ""
    arc.style.strokeDashoffset = "1"
  }, [])

  const hold = useMemo(() => createHoldToConfirm({
    durationMs: HOLD_TO_STOP_MS,
    clock: browserClock,
    onProgress: (progress) => {
      if (arcRef.current) arcRef.current.style.strokeDashoffset = String(1 - progress)
    },
    onConfirm: () => {
      detach()
      setPhase("confirmed")
      onConfirmRef.current()
    },
  }), [detach])

  /** Give the hold up: the key came up, or something took the page's attention. */
  const release = useCallback(() => {
    if (hold.release() === null) return
    detach()
    emptyRing(false)
    setPhase("released")
    clearTimer()
    timerRef.current = window.setTimeout(() => {
      setRingShown(false)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        setPhase((current) => (current === "released" ? "idle" : current))
      }, HINT_LINGER_MS - RELEASE_MS)
    }, RELEASE_MS)
  }, [clearTimer, detach, emptyRing, hold])

  const press = useCallback((origin: HTMLElement) => {
    if (!enabled || hold.isHolding() || phase === "confirmed") return
    clearTimer()
    // A press that lands while the ring is still on its way back takes it
    // from where it is. Read before the transition is switched off, which
    // is what freezes it there.
    const arc = arcRef.current
    let from = 0
    if (arc) {
      const offset = Number.parseFloat(getComputedStyle(arc).strokeDashoffset)
      if (Number.isFinite(offset)) from = Math.min(1, Math.max(0, 1 - offset))
      arc.style.transition = "none"
    }
    setRingShown(true)
    setPhase("holding")
    hold.press(from)

    // Everything that ends a hold short of its time. `keyup` is listened for
    // on the window: the key can come up after focus has gone elsewhere.
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === "Escape") release() }
    const onVisibility = () => { if (document.visibilityState === "hidden") release() }
    const onFocusIn = (event: FocusEvent) => { if (event.target !== origin) release() }
    window.addEventListener("keyup", onKeyUp, true)
    window.addEventListener("blur", release)
    document.addEventListener("visibilitychange", onVisibility)
    document.addEventListener("focusin", onFocusIn)
    origin.addEventListener("blur", release)
    detachRef.current = () => {
      window.removeEventListener("keyup", onKeyUp, true)
      window.removeEventListener("blur", release)
      document.removeEventListener("visibilitychange", onVisibility)
      document.removeEventListener("focusin", onFocusIn)
      origin.removeEventListener("blur", release)
    }
  }, [clearTimer, enabled, hold, phase, release])

  // The turn is over: by this hold, or by itself while the key was down.
  // Either way there is nothing left to show a hold for, and no hint to give.
  useEffect(() => {
    if (enabled) return
    hold.release()
    detach()
    clearTimer()
    emptyRing(true)
    setRingShown(false)
    setPhase("idle")
  }, [clearTimer, detach, emptyRing, enabled, hold])

  // A closed ring that the turn did not answer goes back like a release.
  useEffect(() => {
    if (phase !== "confirmed") return
    const timer = window.setTimeout(() => {
      emptyRing(false)
      setRingShown(false)
      setPhase("idle")
    }, CONFIRMED_LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [emptyRing, phase])

  useEffect(() => () => {
    hold.release()
    detach()
    clearTimer()
  }, [clearTimer, detach, hold])

  return {
    arcRef,
    ringShown,
    hintShown: phase === "holding" || phase === "released",
    engaged: phase === "holding" || phase === "confirmed",
    press,
  }
}

/**
 * The ring. Lies 2px clear of the button it is placed over and 4px beyond
 * its edge, whatever the button's size: it is sized from its positioned
 * parent, which should be a box that hugs the button and nothing else.
 *
 * Drawn as an SVG stroke with the path's length normalised to 1, so the
 * offset is the fraction still to go and no circumference is worked out
 * anywhere. A stroke is painted, not composited; on a 50px ring that is
 * nothing, and it is the only way to draw an arc that is one element with
 * one value to run back from. The retreat is a CSS transition, so letting
 * go mid-hold reverses from the value on screen.
 */
export function HoldToStopRing({ arcRef, shown }: {
  arcRef: RefObject<SVGCircleElement | null>
  shown: boolean
}) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 48 48"
      // Turned a quarter back so the arc starts at twelve o'clock. The colour
      // is the Stop button's own fill, so the ring reads as part of it.
      className="pointer-events-none absolute -left-1 -top-1 size-[calc(100%+8px)] -rotate-90 text-slate-600 dark:text-white"
      style={{ visibility: shown ? "visible" : "hidden" }}
    >
      {/* The whole ring, faint, so the arc has somewhere to be going. */}
      <circle cx="24" cy="24" r="23" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle
        ref={arcRef}
        cx="24"
        cy="24"
        r="23"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        pathLength={1}
        strokeDasharray="1"
        // The release. Reduced motion keeps the ring (it is the only sign a
        // hold is running) and drops the eased run back for an instant one.
        className="transition-[stroke-dashoffset] duration-200 ease-snappy motion-reduce:transition-none"
        style={{ strokeDashoffset: 1 }}
      />
    </svg>
  )
}

/**
 * Says the key has to be held, from the first moment it is down and for a
 * moment after a tap. Without it a tap that used to stop the turn now seems
 * to do nothing. It appears and goes at once: Escape gets one moving thing,
 * and that is the ring.
 *
 * Placed above its positioned parent, at its right edge. The spoken copy is
 * always in the tree, so that filling it in is announced.
 */
export function HoldToStopHint({ shown }: { shown: boolean }) {
  return (
    <>
      <span role="status" className="sr-only">{shown ? "Hold Escape to stop" : ""}</span>
      {shown ? (
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-full right-0 z-30 mb-2.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 py-1 text-xs text-card-foreground"
        >
          Hold <kbd className="font-sans font-medium">Esc</kbd> to stop
        </span>
      ) : null}
    </>
  )
}
