import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ClampedMessageText, CLAMP_LINES, clampTransitionMs } from "./ClampedMessageText"

test("the text starts clamped, with no control until it is known to overflow", () => {
  const html = renderToStaticMarkup(<ClampedMessageText text={"a short prompt"} />)
  expect(html).toContain("a short prompt")
  // The class and the constant say the same number.
  expect(html).toContain(`max-h-[${CLAMP_LINES}lh] overflow-hidden`)
  // Nothing is measured without a layout, so nothing claims there is more.
  expect(html).not.toContain("Show more")
  expect(html).not.toContain("mask-image")
})

test("the text is a box of its own inside the clamp, so its real height can be watched", () => {
  const html = renderToStaticMarkup(<ClampedMessageText text={"one\n\ntwo"} />)
  // Clamp, then the text's own box, then the paragraphs as that box's
  // children, where `first:mt-0` lands on the first.
  expect(html).toMatch(/<div id="[^"]+" class="max-h-\[5lh\] overflow-hidden"><div class="[^"]*whitespace-pre-line[^"]*"><p /)
})

describe("clampTransitionMs", () => {
  const press = { from: 120, to: 420, reducedMotion: false, byKeyboard: false, startsAboveView: false }

  test("opening takes a beat longer than closing, and both stay under 300ms", () => {
    const opening = clampTransitionMs({ ...press, expanding: true })
    const closing = clampTransitionMs({ ...press, from: 420, to: 120, expanding: false })
    expect(opening).toBe(200)
    expect(closing).toBe(160)
  })

  test("a move too long to follow is not eased", () => {
    expect(clampTransitionMs({ ...press, to: 120 + 800, expanding: true })).toBe(200)
    expect(clampTransitionMs({ ...press, to: 120 + 801, expanding: true })).toBeNull()
    expect(clampTransitionMs({ ...press, from: 3000, to: 120, expanding: false })).toBeNull()
  })

  test("nor is one made by a key, or for a reader who asked for less motion", () => {
    expect(clampTransitionMs({ ...press, expanding: true, byKeyboard: true })).toBeNull()
    expect(clampTransitionMs({ ...press, expanding: true, reducedMotion: true })).toBeNull()
  })

  test("a collapse that starts above the view is a cut, because the page is about to be moved to it", () => {
    expect(clampTransitionMs({ ...press, from: 420, to: 120, expanding: false, startsAboveView: true })).toBeNull()
    // Opening has nowhere to be moved to.
    expect(clampTransitionMs({ ...press, expanding: true, startsAboveView: true })).toBe(200)
  })

  test("nothing eases when there is nowhere to go, or no way to know where", () => {
    expect(clampTransitionMs({ ...press, to: 120, expanding: true })).toBeNull()
    expect(clampTransitionMs({ ...press, to: Number.NaN, expanding: false })).toBeNull()
  })
})
