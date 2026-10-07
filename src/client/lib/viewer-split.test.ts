import { describe, expect, test } from "bun:test"
import { resolveViewerSplitMove, viewerPaneState } from "./viewer-split"

describe("the chat's width under the viewer", () => {
  test("a viewer is closed, docked beside the chat, or expanded over it", () => {
    expect(viewerPaneState(false, false)).toBe("closed")
    // What a closed viewer was last set to does not matter.
    expect(viewerPaneState(false, true)).toBe("closed")
    expect(viewerPaneState(true, false)).toBe("docked")
    expect(viewerPaneState(true, true)).toBe("expanded")
  })

  test("the chat makes room for a docked pane with a slide, and takes it back with one", () => {
    expect(resolveViewerSplitMove("closed", "docked", true)).toEqual({ to: "docked", animate: true })
    expect(resolveViewerSplitMove("docked", "closed", true)).toEqual({ to: "closed", animate: true })
    // A review to a preview: another width, the same pane.
    expect(resolveViewerSplitMove("docked", "docked", true)).toEqual({ to: "docked", animate: true })
  })

  test("nothing moves under a pane that covers the chat", () => {
    // Opened straight to expanded, a visualization's Expand: the chat keeps its width.
    expect(resolveViewerSplitMove("closed", "expanded", true)).toEqual({ to: "hold", animate: false })
    // Expanded from its pane: the chat stays as narrow as it was.
    expect(resolveViewerSplitMove("docked", "expanded", true)).toEqual({ to: "hold", animate: false })
    // Another item, another width class, while expanded.
    expect(resolveViewerSplitMove("expanded", "expanded", true)).toEqual({ to: "hold", animate: false })
  })

  test("leaving expanded sets the chat's width once, behind the card", () => {
    expect(resolveViewerSplitMove("expanded", "closed", true)).toEqual({ to: "closed", animate: false })
    // Collapsed into its pane, or closed back onto a docked chat preview.
    expect(resolveViewerSplitMove("expanded", "docked", true)).toEqual({ to: "docked", animate: false })
  })

  test("another chat, a new split and reduced motion take their layout without a slide", () => {
    expect(resolveViewerSplitMove("closed", "docked", false)).toEqual({ to: "docked", animate: false })
    expect(resolveViewerSplitMove("docked", "closed", false)).toEqual({ to: "closed", animate: false })
    expect(resolveViewerSplitMove("docked", "docked", false)).toEqual({ to: "docked", animate: false })
    // A reload onto an expanded item leaves the split where it starts, at the chat's full width.
    expect(resolveViewerSplitMove("closed", "expanded", false)).toEqual({ to: "hold", animate: false })
  })

  test("a closed viewer staying closed is not a move to animate", () => {
    expect(resolveViewerSplitMove("closed", "closed", true)).toEqual({ to: "closed", animate: false })
  })
})
