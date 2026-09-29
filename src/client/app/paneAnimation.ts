/**
 * One clock and one curve for every pane that opens beside or under the chat:
 * the left sidebar, the widget column, the terminal and the viewer (opening,
 * closing, and expanding over the chat). They're the same gesture, a panel
 * making room, so they should move alike.
 *
 * The curve is iOS's drawer glide (`--ease-glide` in index.css): it leaves
 * fast and settles long, so the pane answers at once and lands softly.
 * Closing is quicker than opening: you're done with what's in it. The left
 * sidebar sets the same values in its classes (KannaSidebar); keep them equal.
 *
 * Under reduced motion a pane takes its new size at once. It's movement
 * across a large part of the screen, the kind that setting asks to drop.
 */
export const PANE_OPEN_MS = 300
export const PANE_CLOSE_MS = 240
export const PANE_EASING = "cubic-bezier(0.32, 0.72, 0, 1)"

const GLIDE: [number, number, number, number] = [0.32, 0.72, 0, 1]
const NEWTON_ITERATIONS = 8
const NEWTON_EPSILON = 1e-6

export function paneDurationMs(opening: boolean) {
  return opening ? PANE_OPEN_MS : PANE_CLOSE_MS
}

export function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
}

function sampleCurveX(t: number, x1: number, x2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * x1 + 3 * inverse * t * t * x2 + t * t * t
}

function sampleCurveY(t: number, y1: number, y2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * t * y1 + 3 * inverse * t * t * y2 + t * t * t
}

function sampleCurveDerivativeX(t: number, x1: number, x2: number) {
  const inverse = 1 - t
  return 3 * inverse * inverse * x1 + 6 * inverse * t * (x2 - x1) + 3 * t * t * (1 - x2)
}

function solveBezierTForX(x: number, x1: number, x2: number) {
  let t = x

  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const currentX = sampleCurveX(t, x1, x2) - x
    if (Math.abs(currentX) < NEWTON_EPSILON) {
      return t
    }

    const derivative = sampleCurveDerivativeX(t, x1, x2)
    if (Math.abs(derivative) < NEWTON_EPSILON) {
      break
    }

    t -= currentX / derivative
  }

  return t
}

/** `PANE_EASING`, for the panes whose layout is stepped frame by frame. */
export function easePane(progress: number) {
  if (progress <= 0) return 0
  if (progress >= 1) return 1

  const [x1, y1, x2, y2] = GLIDE
  const t = solveBezierTForX(progress, x1, x2)
  return sampleCurveY(t, y1, y2)
}

export function interpolateLayout(start: [number, number], end: [number, number], progress: number): [number, number] {
  const eased = easePane(progress)
  return [
    start[0] + (end[0] - start[0]) * eased,
    start[1] + (end[1] - start[1]) * eased,
  ]
}
