import { describe, expect, test } from "bun:test"
import { easePane, interpolateLayout, paneDurationMs, PANE_CLOSE_MS, PANE_OPEN_MS } from "./paneAnimation"
import { resolveTerminalAnimationState, shouldRequestTerminalFocus } from "./useTerminalToggleAnimation"

describe("paneAnimation", () => {
  test("clamps easing at the ends", () => {
    expect(easePane(-1)).toBe(0)
    expect(easePane(0)).toBe(0)
    expect(easePane(1)).toBe(1)
    expect(easePane(2)).toBe(1)
  })

  test("interpolates panel layouts", () => {
    expect(interpolateLayout([68, 32], [100, 0], 0)).toEqual([68, 32])
    expect(interpolateLayout([68, 32], [100, 0], 1)).toEqual([100, 0])

    const midpoint = interpolateLayout([100, 0], [68, 32], 0.5)
    expect(midpoint[0]).toBeCloseTo(69.44609882663646, 4)
    expect(midpoint[1]).toBeCloseTo(30.553901173363542, 4)
  })

  test("closes quicker than it opens", () => {
    expect(paneDurationMs(true)).toBe(PANE_OPEN_MS)
    expect(paneDurationMs(false)).toBe(PANE_CLOSE_MS)
    expect(PANE_CLOSE_MS).toBeLessThan(PANE_OPEN_MS)
  })

  test("animates the first open after the project view is already mounted", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: "project-1",
      projectId: "project-1",
      previousShouldRenderTerminalLayout: false,
      previousShowTerminalPane: false,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [68, 32],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.currentLayout).toEqual([100, 0])
    expect(result.targetLayout).toEqual([68, 32])
    expect(result.shouldSkipAnimation).toBe(false)
  })

  test("skips animation on the first render for a newly mounted project", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: null,
      projectId: "project-1",
      previousShouldRenderTerminalLayout: false,
      previousShowTerminalPane: false,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [68, 32],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.shouldSkipAnimation).toBe(true)
  })

  test("skips animation when switching projects", () => {
    const result = resolveTerminalAnimationState({
      previousProjectId: "project-1",
      projectId: "project-2",
      previousShouldRenderTerminalLayout: true,
      previousShowTerminalPane: true,
      showTerminalPane: true,
      terminalLayout: {
        isVisible: true,
        mainSizes: [60, 40],
        terminals: [],
        nextTerminalIndex: 1,
      },
      liveLayout: [68, 32],
    })

    expect(result.shouldSkipAnimation).toBe(true)
    expect(result.currentLayout).toEqual([68, 32])
    expect(result.targetLayout).toEqual([60, 40])
  })

  test("does not request terminal focus on the initial chat mount when the terminal is already open", () => {
    expect(shouldRequestTerminalFocus({
      previousProjectId: null,
      projectId: "project-1",
      showTerminalPane: true,
      wasTerminalVisible: false,
    })).toBe(false)
  })

  test("requests terminal focus only when the user opens the terminal after the project is already mounted", () => {
    expect(shouldRequestTerminalFocus({
      previousProjectId: "project-1",
      projectId: "project-1",
      showTerminalPane: true,
      wasTerminalVisible: false,
    })).toBe(true)
  })
})
