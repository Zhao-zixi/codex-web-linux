import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_RIGHT_SIDEBAR_SIZE, persistedChatViewers, useRightSidebarStore } from "../../stores/rightSidebarStore"
import { getChatViewer, isChatTrailItem, openViewer, useViewerStore, viewerWidthClass } from "../../stores/viewerStore"

const GRAPH = { kind: "graph", chatId: "page-chat" } as const
const PICKED = { kind: "chat", chatId: "sub-1", graph: "page-chat" } as const
const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const

/** The graph as one more thing the viewer's pane shows, and the chat picked from it. */
describe("the graph in the viewer", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {} })
    useViewerStore.setState({ chatKey: "", openCount: 0, chatJump: null, liveChatId: null })
    useViewerStore.getState().setChat("page-chat")
  })

  test("is the previewer's own subject, like a chat, not something opened over one", () => {
    expect(isChatTrailItem(GRAPH)).toBe(true)
    expect(isChatTrailItem(PICKED)).toBe(true)
    expect(isChatTrailItem(FILE)).toBe(false)
  })

  test("shares a chat's width, so the pane holds still while the graph turns into a chat", () => {
    expect(viewerWidthClass(GRAPH)).toBe(viewerWidthClass(PICKED))
    openViewer(GRAPH)
    useViewerStore.getState().setWidth(560)
    openViewer(PICKED)
    expect(getChatViewer()).toEqual({ item: PICKED, expanded: false, widthPx: 560 })
    openViewer(GRAPH)
    expect(getChatViewer()?.widthPx).toBe(560)
  })

  test("a chat picked from it carries the way back, and closing shuts the pane", () => {
    openViewer(GRAPH)
    openViewer(PICKED)
    const viewer = getChatViewer()
    expect(viewer?.item).toEqual(PICKED)
    // Back is the chat's own control, and reads `graph`. Close is close.
    expect(viewer?.returnTo).toBeUndefined()
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()
  })

  test("a file opened over it closes back to it", () => {
    openViewer(GRAPH)
    openViewer(FILE)
    useViewerStore.getState().close()
    expect(getChatViewer()?.item).toEqual(GRAPH)
  })

  test("a file opened over a chat picked from it closes back to that chat, graph and all", () => {
    openViewer(PICKED)
    openViewer(FILE)
    useViewerStore.getState().close()
    expect(getChatViewer()?.item).toEqual(PICKED)
  })

  test("comes back after a reload, as the graph or as the chat picked from it", () => {
    openViewer(GRAPH)
    expect(persistedChatViewers(useRightSidebarStore.getState().chatViewers)["page-chat"]?.item).toEqual(GRAPH)
    openViewer(PICKED)
    expect(persistedChatViewers(useRightSidebarStore.getState().chatViewers)["page-chat"]?.item).toEqual(PICKED)
  })

  test("is each chat's own: another chat's pane does not show it", () => {
    openViewer(GRAPH)
    useViewerStore.getState().setChat("other-chat")
    expect(getChatViewer()).toBeNull()
    useViewerStore.getState().setChat("page-chat")
    expect(getChatViewer()?.item).toEqual(GRAPH)
  })
})
