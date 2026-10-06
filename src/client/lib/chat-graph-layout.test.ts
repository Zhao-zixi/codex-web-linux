import { describe, expect, test } from "bun:test"
import { buildChatGraph, type ChatGraphRow } from "./chat-graph"
import {
  getChatGraphContentSize,
  getInitialGraphViewport,
  isSpringAtRest,
  layoutChatGraph,
  stepCriticalSpring,
  type ChatGraphLayoutOptions,
} from "./chat-graph-layout"

const OPTIONS: ChatGraphLayoutOptions = { direction: "columns", nodeWidth: 300, columnGap: 60, indent: 30, rowGap: 20, estimatedHeight: 100 }
const OUTLINE: ChatGraphLayoutOptions = { ...OPTIONS, direction: "outline" }

function row(chatId: string, parentChatId?: string, createdAt = 0): ChatGraphRow {
  return { chatId, _creationTime: createdAt, ...(parentChatId ? { parentChatId } : {}) }
}

/**
 * root ─┬─ a ─┬─ a1
 *       │     └─ a2
 *       └─ b
 */
const ROWS: ChatGraphRow[] = [
  row("root"),
  row("a", "root", 10),
  row("b", "root", 20),
  row("a1", "a", 30),
  row("a2", "a", 40),
]

function layout(rows: ChatGraphRow[], heights: Record<string, number> = {}) {
  return layoutChatGraph(buildChatGraph(rows, "root")!, new Map(Object.entries(heights)), OPTIONS)
}

describe("layoutChatGraph", () => {
  test("puts the root at the origin and each generation in its own column", () => {
    const positions = layout(ROWS)
    expect(positions.get("root")).toEqual({ x: 0, y: 0 })
    expect(positions.get("a")?.x).toBe(360)
    expect(positions.get("b")?.x).toBe(360)
    expect(positions.get("a1")?.x).toBe(720)
    expect(positions.get("a2")?.x).toBe(720)
  })

  test("a first child is level with its parent", () => {
    const positions = layout(ROWS)
    expect(positions.get("a")?.y).toBe(0)
    expect(positions.get("a1")?.y).toBe(0)
  })

  test("a chat sits below everything under the sibling before it", () => {
    const positions = layout(ROWS)
    expect(positions.get("a2")?.y).toBe(120)
    // Under a's two children (0-100, 120-220), not under a itself (0-100).
    expect(positions.get("b")?.y).toBe(240)
  })

  test("a tall chat with short children still clears the one below it", () => {
    const positions = layout(ROWS, { a: 500 })
    expect(positions.get("b")?.y).toBe(520)
  })

  test("uses each node's own height once it is known", () => {
    const positions = layout(ROWS, { a1: 40 })
    expect(positions.get("a2")?.y).toBe(60)
  })

  test("a new sub-chat moves nothing that came before it, and nothing sideways", () => {
    const before = layout(ROWS)
    const after = layout([...ROWS, row("a3", "a", 50)])
    expect(after.get("a3")).toEqual({ x: 720, y: 240 })
    for (const id of ["root", "a", "a1", "a2"]) expect(after.get(id)).toEqual(before.get(id)!)
    // Only what is below it moves, and only down.
    expect(after.get("b")).toEqual({ x: before.get("b")!.x, y: 360 })
  })

  test("a new sub-chat at the end of the tree moves nothing at all", () => {
    const before = layout(ROWS)
    const after = layout([...ROWS, row("c", "root", 60)])
    for (const [id, position] of before) expect(after.get(id)).toEqual(position)
    expect(after.get("c")).toEqual({ x: 360, y: 360 })
  })

  test("no two chats in a column overlap", () => {
    const rows = [...ROWS, row("b1", "b", 50), row("b2", "b", 60), row("a1x", "a1", 70), row("a1y", "a1", 80)]
    const heights: Record<string, number> = { root: 180, a: 90, a1: 260, a1x: 50, b2: 140 }
    const positions = layout(rows, heights)
    const columns = new Map<number, Array<{ top: number; bottom: number }>>()
    for (const [id, position] of positions) {
      const spans = columns.get(position.x) ?? []
      spans.push({ top: position.y, bottom: position.y + (heights[id] ?? OPTIONS.estimatedHeight) })
      columns.set(position.x, spans)
    }
    for (const spans of columns.values()) {
      spans.sort((left, right) => left.top - right.top)
      for (let index = 1; index < spans.length; index += 1) {
        expect(spans[index]!.top).toBeGreaterThanOrEqual(spans[index - 1]!.bottom + OPTIONS.rowGap)
      }
    }
  })
})

describe("layoutChatGraph as an outline", () => {
  function outline(rows: ChatGraphRow[], heights: Record<string, number> = {}) {
    return layoutChatGraph(buildChatGraph(rows, "root")!, new Map(Object.entries(heights)), OUTLINE)
  }

  test("stacks the tree top to bottom, parents over their children, each generation set in", () => {
    const positions = outline(ROWS)
    expect([...positions.entries()]).toEqual([
      ["root", { x: 0, y: 0 }],
      ["a", { x: 30, y: 120 }],
      ["a1", { x: 60, y: 240 }],
      ["a2", { x: 60, y: 360 }],
      ["b", { x: 30, y: 480 }],
    ])
  })

  test("uses each node's own height", () => {
    const positions = outline(ROWS, { root: 40, a1: 300 })
    expect(positions.get("a")?.y).toBe(60)
    expect(positions.get("a1")?.y).toBe(180)
    expect(positions.get("a2")?.y).toBe(180 + 300 + 20)
  })

  test("a new sub-chat moves only what comes after it, straight down", () => {
    const before = outline(ROWS)
    const after = outline([...ROWS, row("a3", "a", 50)])
    expect(after.get("a3")).toEqual({ x: 60, y: 480 })
    for (const id of ["root", "a", "a1", "a2"]) expect(after.get(id)).toEqual(before.get(id)!)
    expect(after.get("b")).toEqual({ x: before.get("b")!.x, y: 600 })
  })

  test("three generations are one node and two indents wide", () => {
    const positions = outline(ROWS)
    expect(getChatGraphContentSize(positions, new Map(), OUTLINE)).toEqual({ width: 360, height: 580 })
    // Against three nodes and two gaps, side by side.
    expect(getChatGraphContentSize(layout(ROWS), new Map(), OPTIONS).width).toBe(1020)
  })
})

describe("stepCriticalSpring", () => {
  function run(from: number, target: number, velocity = 0, seconds = 1) {
    let state = { value: from, velocity }
    const values: number[] = []
    for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) {
      state = stepCriticalSpring(state, target, 1 / 60, 0.35)
      values.push(state.value)
    }
    return { state, values }
  }

  test("arrives at the target and stops", () => {
    const { state } = run(0, 200)
    expect(isSpringAtRest(state, 200)).toBe(true)
  })

  test("never overshoots from rest", () => {
    const { values } = run(0, 200)
    expect(Math.max(...values)).toBeLessThanOrEqual(200)
    for (let index = 1; index < values.length; index += 1) {
      expect(values[index]!).toBeGreaterThanOrEqual(values[index - 1]!)
    }
  })

  test("a new target carries on from where the node is, at the speed it has", () => {
    let state = { value: 0, velocity: 0 }
    for (let frame = 0; frame < 6; frame += 1) state = stepCriticalSpring(state, 200, 1 / 60, 0.35)
    const midway = state
    expect(midway.velocity).toBeGreaterThan(0)
    const next = stepCriticalSpring(midway, 400, 1 / 60, 0.35)
    // No restart: it keeps moving forward from where it was.
    expect(next.value).toBeGreaterThan(midway.value)
    expect(next.velocity).toBeGreaterThan(midway.velocity)
  })

  test("one long frame lands in the same place as many short ones", () => {
    const stepped = run(0, 200, 0, 0.5).state
    const once = stepCriticalSpring({ value: 0, velocity: 0 }, 200, 0.5, 0.35)
    expect(once.value).toBeCloseTo(stepped.value, 0)
  })

  test("is not at rest while it is still moving through the target", () => {
    expect(isSpringAtRest({ value: 200, velocity: 300 }, 200)).toBe(false)
    expect(isSpringAtRest({ value: 150, velocity: 0 }, 200)).toBe(false)
  })
})

describe("getInitialGraphViewport", () => {
  const base = {
    canvas: { width: 1000, height: 800 },
    insets: { top: 60, right: 20, bottom: 160, left: 20 },
    minZoom: 0.6,
    maxZoom: 1,
  }

  test("a small graph is shown at life size, centred in the room left for it", () => {
    expect(getInitialGraphViewport({ ...base, content: { width: 300, height: 100 } }))
      .toEqual({ x: 20 + (960 - 300) / 2, y: 60 + (580 - 100) / 2, zoom: 1 })
  })

  test("a graph a little too big is shrunk to fit", () => {
    const viewport = getInitialGraphViewport({ ...base, content: { width: 1200, height: 400 } })
    expect(viewport.zoom).toBeCloseTo(0.8)
    expect(viewport.x).toBeCloseTo(20)
  })

  test("a graph too tall to show whole is fitted across, with its head in view", () => {
    const viewport = getInitialGraphViewport({ ...base, content: { width: 1000, height: 6000 } })
    // Not shrunk for a height it could never fit: the tree scrolls.
    expect(viewport.zoom).toBeCloseTo(0.96)
    // Held at the top, under the navbar; the far end of the tree is what is cut off.
    expect(viewport.y).toBe(60)
    expect(viewport.x).toBeCloseTo(20)
  })

  test("a graph far too wide stays readable, with its head in view", () => {
    const viewport = getInitialGraphViewport({ ...base, content: { width: 4000, height: 6000 } })
    expect(viewport.zoom).toBe(0.6)
    expect(viewport.x).toBe(20)
    expect(viewport.y).toBe(60)
  })

  test("a tall graph starts where the chat the reader is in can be seen", () => {
    const tall = { ...base, content: { width: 300, height: 6000 } }
    // Room is 580 tall. A node at 3000 would be far below the fold.
    const viewport = getInitialGraphViewport({ ...tall, focus: { top: 3000, bottom: 3150 } })
    expect(viewport.zoom).toBe(1)
    // The node sits a quarter of the way down the room.
    expect(viewport.y + 3000).toBe(60 + 580 / 4)
  })

  test("a chat already in view leaves the graph at its head", () => {
    const tall = { ...base, content: { width: 300, height: 6000 } }
    expect(getInitialGraphViewport({ ...tall, focus: { top: 200, bottom: 350 } }).y).toBe(60)
  })

  test("the view never starts past the end of the tree", () => {
    const tall = { ...base, content: { width: 300, height: 6000 } }
    const viewport = getInitialGraphViewport({ ...tall, focus: { top: 5900, bottom: 6000 } })
    // The tree's last pixel is at the foot of the room, not above it.
    expect(viewport.y + 6000).toBe(60 + 580)
  })

  test("an empty graph does not divide by nothing", () => {
    expect(getInitialGraphViewport({ ...base, content: { width: 0, height: 0 } }).zoom).toBe(1)
  })
})
