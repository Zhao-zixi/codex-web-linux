import { beforeEach, describe, expect, test } from "bun:test"
import { getDefaultProjectTerminalLayout, isTerminalVisible, useTerminalLayoutStore } from "./terminalLayoutStore"

const PROJECT_ID = "project-1"

describe("terminalLayoutStore", () => {
  beforeEach(() => {
    useTerminalLayoutStore.setState({ projects: {} })
  })

  test("adds the first terminal and shows the workspace", () => {
    const terminalId = useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
    expect(layout.terminals[0]?.id).toBe(terminalId)
    expect(layout.terminals[0]?.title).toBe("Terminal A")
  })

  test("keeps layouts isolated per project", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    useTerminalLayoutStore.getState().addTerminal("project-2")
    useTerminalLayoutStore.getState().addTerminal("project-2")

    expect(useTerminalLayoutStore.getState().projects[PROJECT_ID]?.terminals).toHaveLength(1)
    expect(useTerminalLayoutStore.getState().projects["project-2"]?.terminals).toHaveLength(2)
  })

  test("removing the last terminal hides the workspace", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    const terminalId = useTerminalLayoutStore.getState().projects[PROJECT_ID]?.terminals[0]?.id
    expect(terminalId).toBeString()

    useTerminalLayoutStore.getState().removeTerminal(PROJECT_ID, terminalId!)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.isVisible).toBe(false)
    expect(layout.terminals).toHaveLength(0)
  })

  test("hiding keeps the panes so their shells stay attached", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    const terminalId = useTerminalLayoutStore.getState().projects[PROJECT_ID]?.terminals[0]?.id

    useTerminalLayoutStore.getState().hideTerminals(PROJECT_ID)

    const hidden = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(hidden.isVisible).toBe(false)
    expect(hidden.terminals).toHaveLength(1)

    useTerminalLayoutStore.getState().toggleVisibility(PROJECT_ID)

    const shown = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(shown.isVisible).toBe(true)
    expect(shown.terminals[0]?.id).toBe(terminalId)
  })

  test("a chat key shows and hides the pane for that chat only", () => {
    const store = useTerminalLayoutStore.getState()
    store.addTerminal(PROJECT_ID, undefined, "chat-a")

    const layout = () => useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(isTerminalVisible(layout(), "chat-a")).toBe(true)
    expect(isTerminalVisible(layout(), "chat-b")).toBe(false)
    expect(isTerminalVisible(layout())).toBe(false)

    store.toggleVisibility(PROJECT_ID, "chat-b")
    store.hideTerminals(PROJECT_ID, "chat-a")
    expect(isTerminalVisible(layout(), "chat-a")).toBe(false)
    expect(isTerminalVisible(layout(), "chat-b")).toBe(true)
    expect(layout().terminals).toHaveLength(1)
  })

  test("removing the last terminal forgets every chat's visibility", () => {
    const terminalId = useTerminalLayoutStore.getState().addTerminal(PROJECT_ID, undefined, "chat-a")
    useTerminalLayoutStore.getState().removeTerminal(PROJECT_ID, terminalId)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.chatVisibility).toBeUndefined()
    expect(isTerminalVisible(layout, "chat-a")).toBe(false)
  })

  test("resetting main sizes restores the default split without removing terminals", () => {
    useTerminalLayoutStore.getState().addTerminal(PROJECT_ID)
    useTerminalLayoutStore.getState().setMainSizes(PROJECT_ID, [80, 20])

    useTerminalLayoutStore.getState().resetMainSizes(PROJECT_ID)

    const layout = useTerminalLayoutStore.getState().projects[PROJECT_ID] ?? getDefaultProjectTerminalLayout()
    expect(layout.mainSizes).toEqual([68, 32])
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
  })
})
