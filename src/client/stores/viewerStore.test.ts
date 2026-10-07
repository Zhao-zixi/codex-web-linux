import { beforeEach, describe, expect, test } from "bun:test"
import { DEFAULT_RIGHT_SIDEBAR_SIZE, persistedChatViewers, useRightSidebarStore } from "./rightSidebarStore"
import { getChatViewer, openViewer, useViewerStore } from "./viewerStore"

const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const
const DIFF = { kind: "diff", projectId: "p1", path: "src/a.ts" } as const
const CHAT = { kind: "chat", chatId: "sub-1" } as const
const VISUALIZATION = { kind: "visualization", artifact: { type: "visualization", version: 1, title: "Signups", height: 360, url: "/api/chats/chat-1/media/visualization-abc.html" } } as const
const IMAGE = { kind: "attachment", attachment: { url: "/media/a.png", name: "a.png", mimeType: "image/png", size: 1 } } as const

describe("viewerStore", () => {
  beforeEach(() => {
    useRightSidebarStore.setState({ size: DEFAULT_RIGHT_SIDEBAR_SIZE, projects: {}, projectUi: {}, chatViewers: {} })
    useViewerStore.setState({ chatKey: "", openCount: 0, chatJump: null, liveChatId: null })
    useViewerStore.getState().setChat("chat-1")
  })

  test("each chat keeps its own viewer, expanded state and width", () => {
    openViewer(FILE)
    useViewerStore.getState().toggleExpanded()
    useViewerStore.getState().setWidth(700)

    useViewerStore.getState().setChat("chat-2")
    expect(getChatViewer()).toBeNull()

    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()).toEqual({ item: FILE, expanded: true, widthPx: 700 })
  })

  test("a dragged width holds within a kind and resets across review and preview", () => {
    openViewer(FILE)
    useViewerStore.getState().setWidth(700)
    openViewer({ ...FILE, path: "docs/b.md" })
    expect(getChatViewer()?.widthPx).toBe(700)
    openViewer(DIFF)
    expect(getChatViewer()?.widthPx).toBeUndefined()
  })

  test("a review left for another chat reopens at the file it was scrolled to", () => {
    openViewer(DIFF)
    useViewerStore.getState().setScrolledDiffPath("src/b.ts")
    expect(getChatViewer()?.item).toEqual(DIFF)

    useViewerStore.getState().setChat("chat-2")
    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()?.item).toEqual({ ...DIFF, path: "src/b.ts" })
  })

  test("closing clears only this chat's viewer", () => {
    openViewer(FILE)
    useViewerStore.getState().setChat("chat-2")
    openViewer(DIFF)
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()
    useViewerStore.getState().setChat("chat-1")
    expect(getChatViewer()?.item).toEqual(FILE)
  })

  test("keeps across a reload what can come back, a review at its scrolled file", () => {
    expect(persistedChatViewers({
      "chat-1": { item: DIFF, expanded: false, reviewPath: "src/b.ts" },
      "chat-2": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: false },
      "chat-3": { item: { kind: "attachment", attachment: { url: "blob:abc", name: "a.png", mimeType: "image/png", size: 1 } }, expanded: false },
      "": { item: FILE, expanded: false },
      "chat-4": { item: FILE, expanded: true, widthPx: 640 },
    })).toEqual({
      "chat-1": { item: { ...DIFF, path: "src/b.ts" }, expanded: false },
      "chat-4": { item: FILE, expanded: true, widthPx: 640 },
    })
  })

  test("a chat preview has a width of its own, apart from a file's", () => {
    openViewer(FILE)
    useViewerStore.getState().setWidth(700)
    openViewer(CHAT)
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false })
    useViewerStore.getState().setWidth(520)
    openViewer({ kind: "chat", chatId: "sub-2", back: ["sub-1"] })
    expect(getChatViewer()?.widthPx).toBe(520)
  })

  test("closing what opened over a chat preview goes back to the chat, at its width", () => {
    openViewer(CHAT)
    useViewerStore.getState().setWidth(520)
    openViewer(IMAGE)
    openViewer(FILE)
    expect(getChatViewer()?.item).toEqual(FILE)

    useViewerStore.getState().close()
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false, widthPx: 520 })
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()
  })

  test("another chat replaces a preview outright, and closeAll shuts the pane", () => {
    openViewer(CHAT)
    openViewer({ kind: "chat", chatId: "sub-2" })
    useViewerStore.getState().close()
    expect(getChatViewer()).toBeNull()

    openViewer(CHAT)
    openViewer(IMAGE)
    useViewerStore.getState().closeAll()
    expect(getChatViewer()).toBeNull()
  })

  test("a chat preview comes back after a reload, also from under a chart", () => {
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false, widthPx: 520 },
      "chat-2": {
        item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } },
        expanded: true,
        returnTo: { item: CHAT, widthPx: 480 },
      },
    })).toEqual({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false, widthPx: 520 },
      "chat-2": { item: CHAT, expanded: true, widthPx: 480 },
    })
  })

  test("a visualization opens expanded and gives the pane back as it was", () => {
    // From a closed pane: expanded, and closing leaves nothing behind.
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()).toEqual({ item: VISUALIZATION, expanded: true, expandedBefore: false })
    useViewerStore.getState().close()
    openViewer(FILE)
    expect(getChatViewer()).toEqual({ item: FILE, expanded: false })
    useViewerStore.getState().closeAll()

    // Over a docked chat preview: closing goes back to the chat, docked, at its width.
    openViewer(CHAT)
    useViewerStore.getState().setWidth(520)
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()?.expanded).toBe(true)
    useViewerStore.getState().close()
    expect(getChatViewer()).toEqual({ item: CHAT, expanded: false, widthPx: 520 })

    // Something else opened in its place is not left over the chat either.
    openViewer(VISUALIZATION, { expanded: true })
    openViewer(IMAGE)
    expect(getChatViewer()).toMatchObject({ item: IMAGE, expanded: false })
  })

  test("collapsing or expanding a visualization yourself is the pane's setting from then on", () => {
    openViewer(CHAT)
    openViewer(VISUALIZATION, { expanded: true })
    useViewerStore.getState().toggleExpanded()
    expect(getChatViewer()).toMatchObject({ item: VISUALIZATION, expanded: false })
    expect(getChatViewer()).not.toHaveProperty("expandedBefore")
    useViewerStore.getState().toggleExpanded()
    useViewerStore.getState().close()
    expect(getChatViewer()).toMatchObject({ item: CHAT, expanded: true })
  })

  test("a pane already expanded stays so under a visualization, and it survives a reload", () => {
    openViewer(FILE)
    useViewerStore.getState().toggleExpanded()
    openViewer(VISUALIZATION, { expanded: true })
    expect(getChatViewer()).toEqual({ item: VISUALIZATION, expanded: true })
    expect(persistedChatViewers({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } }))
      .toEqual({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } })
    // A chart does not come back, and the chat under it comes back docked.
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: true, expandedBefore: false, returnTo: { item: CHAT } },
    })).toEqual({ "chat-1": { item: CHAT, expanded: false } })
  })

  test("a jump for the previewed chat is one-shot and dropped with the page's chat", () => {
    useViewerStore.getState().setChatJump("sub-1", "reply")
    const jump = useViewerStore.getState().chatJump
    expect(jump).toMatchObject({ chatId: "sub-1", target: "reply" })
    useViewerStore.getState().clearChatJump("another-request")
    expect(useViewerStore.getState().chatJump).toBe(jump)
    useViewerStore.getState().clearChatJump(jump!.requestId)
    expect(useViewerStore.getState().chatJump).toBeNull()

    useViewerStore.getState().setChatJump("sub-1", "prompt")
    useViewerStore.getState().setChat("chat-2")
    expect(useViewerStore.getState().chatJump).toBeNull()
  })
})
