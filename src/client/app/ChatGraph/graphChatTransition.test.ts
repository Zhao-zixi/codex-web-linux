import { describe, expect, test } from "bun:test"
import {
  clipToRect,
  getGraphChatLayerStyle,
  GRAPH_CHAT_ENTER_MS,
  GRAPH_CHAT_LEAVE_MS,
  type GraphChatPhase,
} from "./graphChatTransition"

const STAGE = { top: 100, left: 600, right: 1100, bottom: 900 }

describe("clipToRect", () => {
  test("a node inside the stage is how far in it sits from each side", () => {
    expect(clipToRect(STAGE, { top: 180, left: 640, right: 960, bottom: 360 }))
      .toBe("inset(80px 140px 540px 40px round 12px)")
  })

  test("a node half off the stage is clipped to the half that shows", () => {
    expect(clipToRect(STAGE, { top: 60, left: 560, right: 880, bottom: 200 }))
      .toBe("inset(0px 220px 700px 0px round 12px)")
  })

  test("a node panned out of sight has no rectangle to grow from", () => {
    expect(clipToRect(STAGE, { top: 1000, left: 640, right: 960, bottom: 1180 })).toBeNull()
    expect(clipToRect(STAGE, { top: 180, left: 100, right: 420, bottom: 360 })).toBeNull()
  })
})

describe("getGraphChatLayerStyle", () => {
  const NODE = "inset(80px 140px 540px 40px round 12px)"

  test("opens from the node's rectangle to the whole pane, and goes back to it", () => {
    expect(getGraphChatLayerStyle("enter", NODE)).toEqual({ opacity: 0, clipPath: NODE })
    expect(getGraphChatLayerStyle("open", NODE).clipPath).toBe("inset(0px 0px 0px 0px round 16px)")
    expect(getGraphChatLayerStyle("leave-from", NODE).clipPath).toBe("inset(0px 0px 0px 0px round 16px)")
    expect(getGraphChatLayerStyle("leave", NODE).clipPath).toBe(NODE)
  })

  test("every clip it moves between is the same shape, so each can ease into the next", () => {
    for (const phase of ["enter", "open", "leave-from", "leave"] as GraphChatPhase[]) {
      expect(getGraphChatLayerStyle(phase, NODE).clipPath).toMatch(/^inset\((?:[\d.]+px ){4}round \d+px\)$/)
    }
  })

  test("a starting state carries no transition, so it is taken up at once", () => {
    expect(getGraphChatLayerStyle("enter", NODE).transition).toBeUndefined()
    expect(getGraphChatLayerStyle("leave-from", NODE).transition).toBeUndefined()
  })

  test("moves only the clip and the opacity, and never eases in", () => {
    for (const phase of ["open", "leave"] as GraphChatPhase[]) {
      const transition = getGraphChatLayerStyle(phase, NODE).transition!
      expect(transition.split(", ").map((part) => part.split(" ")[0])).toEqual(["clip-path", "opacity"])
      expect(transition).not.toContain("ease-in")
      expect(transition).not.toContain("transform")
    }
  })

  test("leaves quicker than it arrives, and both stay under 300ms", () => {
    expect(GRAPH_CHAT_LEAVE_MS).toBeLessThan(GRAPH_CHAT_ENTER_MS)
    expect(GRAPH_CHAT_ENTER_MS).toBeLessThan(300)
  })

  test("settled, the chat is neither clipped nor animating", () => {
    expect(getGraphChatLayerStyle("rest", NODE)).toEqual({})
  })

  test("with no node in sight, or motion reduced, it only fades", () => {
    expect(getGraphChatLayerStyle("enter", null)).toEqual({ opacity: 0 })
    expect(getGraphChatLayerStyle("open", null).clipPath).toBeUndefined()
    expect(getGraphChatLayerStyle("open", null).opacity).toBe(1)
    expect(getGraphChatLayerStyle("leave", null).clipPath).toBeUndefined()
    expect(getGraphChatLayerStyle("leave", null).opacity).toBe(0)
  })
})
