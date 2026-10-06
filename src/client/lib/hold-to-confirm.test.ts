import { describe, expect, test } from "bun:test"
import { createHoldToConfirm, type HoldClock } from "./hold-to-confirm"

/** A clock that moves only when told to, and runs the frames that fall due. */
function fakeClock() {
  let time = 0
  let nextHandle = 1
  const frames = new Map<number, () => void>()
  const clock: HoldClock = {
    now: () => time,
    requestFrame: (callback) => {
      const handle = nextHandle++
      frames.set(handle, callback)
      return handle
    },
    cancelFrame: (handle) => { frames.delete(handle) },
  }
  /** Move time on in 16ms frames, running whatever is queued at each. */
  const advance = (ms: number) => {
    const end = time + ms
    while (time < end) {
      time = Math.min(end, time + 16)
      const due = [...frames.values()]
      frames.clear()
      for (const callback of due) callback()
    }
  }
  return { clock, advance, pendingFrames: () => frames.size }
}

function setup(durationMs = 1500) {
  const { clock, advance, pendingFrames } = fakeClock()
  const progress: number[] = []
  let confirmed = 0
  const hold = createHoldToConfirm({
    durationMs,
    clock,
    onProgress: (value) => progress.push(value),
    onConfirm: () => { confirmed += 1 },
  })
  return { hold, advance, pendingFrames, progress, confirmed: () => confirmed }
}

describe("createHoldToConfirm", () => {
  test("confirms once the whole duration has been held, and not before", () => {
    const { hold, advance, confirmed } = setup()
    hold.press()
    advance(1499)
    expect(confirmed()).toBe(0)
    expect(hold.isHolding()).toBe(true)
    advance(1)
    expect(confirmed()).toBe(1)
    expect(hold.isHolding()).toBe(false)
  })

  test("progress is linear, and complete in the frame that confirms", () => {
    const { hold, advance, progress, confirmed } = setup()
    hold.press()
    expect(progress).toEqual([0])
    advance(750)
    expect(progress[progress.length - 1]).toBeCloseTo(0.5, 2)
    expect(confirmed()).toBe(0)
    advance(750)
    expect(progress[progress.length - 1]).toBe(1)
    expect(confirmed()).toBe(1)
    for (let index = 1; index < progress.length; index += 1) {
      expect(progress[index]!).toBeGreaterThanOrEqual(progress[index - 1]!)
    }
  })

  test("letting go early confirms nothing and reports how far it got", () => {
    const { hold, advance, pendingFrames, confirmed } = setup()
    hold.press()
    advance(600)
    expect(hold.release()).toBeCloseTo(0.4, 2)
    expect(hold.isHolding()).toBe(false)
    expect(pendingFrames()).toBe(0)
    advance(5000)
    expect(confirmed()).toBe(0)
  })

  test("a tap is a release like any other", () => {
    const { hold, advance, confirmed } = setup()
    hold.press()
    advance(80)
    expect(hold.release()).toBeCloseTo(80 / 1500, 2)
    advance(2000)
    expect(confirmed()).toBe(0)
  })

  test("a press while holding does not start over", () => {
    const { hold, advance, confirmed } = setup()
    hold.press()
    advance(1000)
    hold.press()
    advance(500)
    expect(confirmed()).toBe(1)
  })

  test("releasing when nothing is held reports nothing", () => {
    const { hold } = setup()
    expect(hold.release()).toBeNull()
  })

  test("a press over a retreating ring draws on from there but still takes the whole duration", () => {
    const { hold, advance, progress, confirmed } = setup()
    hold.press(0.6)
    expect(progress).toEqual([0.6])
    advance(750)
    expect(progress[progress.length - 1]).toBeCloseTo(0.8, 2)
    advance(749)
    expect(confirmed()).toBe(0)
    advance(1)
    expect(confirmed()).toBe(1)
    expect(progress[progress.length - 1]).toBe(1)
  })

  test("pressing again and again never adds up to a hold", () => {
    const { hold, advance, confirmed } = setup()
    for (let round = 0; round < 10; round += 1) {
      hold.press(0.9)
      advance(1000)
      hold.release()
      advance(50)
    }
    expect(confirmed()).toBe(0)
  })

  test("confirms again on a later hold", () => {
    const { hold, advance, confirmed } = setup()
    hold.press()
    advance(1500)
    hold.press()
    advance(1500)
    expect(confirmed()).toBe(2)
  })
})
