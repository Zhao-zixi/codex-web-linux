/**
 * A hold: something that happens only if a key or a button is kept down for
 * a set time, with the time shown as it runs. Stopping a turn with Escape.
 *
 * One clock for both halves. The progress handed to `onProgress` and the
 * moment `onConfirm` fires are read off the same `now()`, in the same frame,
 * so what draws the progress cannot finish before or after the thing it is
 * counting down to. A CSS transition for the drawing and a timer for the
 * action would be two clocks, and under a busy main thread they part.
 *
 * It only counts up. Letting go stops it and reports how far it had got; the
 * retreat from there is the caller's, and quick (a CSS transition from the
 * value last drawn). Kept free of React and the DOM, with the clock handed
 * in, so the timing is tested with a fake one.
 */

export interface HoldClock {
  now: () => number
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

export interface HoldToConfirm {
  /**
   * Start holding. `from` is where the drawing already is, 0 to 1: a press
   * that lands while the last hold is still retreating goes on from there.
   * The time to hold is the same whole duration either way, so pressing
   * again and again cannot add up to a hold.
   */
  press: (from?: number) => void
  /** Stop without confirming. The progress it had reached, or null if it was not holding. */
  release: () => number | null
  isHolding: () => boolean
}

export function createHoldToConfirm({ durationMs, clock, onProgress, onConfirm }: {
  durationMs: number
  clock: HoldClock
  /** Called each frame of a hold with how far along it is, 0 to 1. */
  onProgress: (progress: number) => void
  onConfirm: () => void
}): HoldToConfirm {
  let holding: { startedAt: number; from: number; frame: number } | null = null

  const progressAt = (hold: { startedAt: number; from: number }, now: number) => {
    const elapsed = Math.min(1, Math.max(0, (now - hold.startedAt) / durationMs))
    return hold.from + (1 - hold.from) * elapsed
  }

  const tick = () => {
    const hold = holding
    if (!hold) return
    const now = clock.now()
    // Drawn before it is decided: the frame that confirms shows it complete.
    onProgress(progressAt(hold, now))
    if (now - hold.startedAt >= durationMs) {
      holding = null
      onConfirm()
      return
    }
    hold.frame = clock.requestFrame(tick)
  }

  return {
    press: (from = 0) => {
      if (holding) return
      const start = Math.min(Math.max(from, 0), 1)
      holding = { startedAt: clock.now(), from: start, frame: 0 }
      onProgress(start)
      holding.frame = clock.requestFrame(tick)
    },
    release: () => {
      const hold = holding
      if (!hold) return null
      clock.cancelFrame(hold.frame)
      holding = null
      return progressAt(hold, clock.now())
    },
    isHolding: () => holding !== null,
  }
}
