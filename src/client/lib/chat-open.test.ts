import { describe, expect, test } from "bun:test"
import { chatIdFromChatPath, resolveChatOpen, type ChatOpenRequest } from "./chat-open"

function request(overrides: Partial<ChatOpenRequest>): ChatOpenRequest {
  return {
    chatId: "other",
    pageChatId: "main",
    pageShowsTranscript: true,
    preview: null,
    from: "page",
    newTab: false,
    tabsEnabled: false,
    canPreview: true,
    ...overrides,
  }
}

describe("resolveChatOpen", () => {
  test("a reference to another chat opens it in the previewer", () => {
    expect(resolveChatOpen(request({}))).toEqual({ kind: "preview", back: [] })
  })

  test("a page without a previewer navigates", () => {
    expect(resolveChatOpen(request({ canPreview: false }))).toEqual({ kind: "navigate" })
  })

  test("a modifier click skips the previewer for a background tab", () => {
    expect(resolveChatOpen(request({ newTab: true, tabsEnabled: true }))).toEqual({ kind: "background-tab" })
  })

  test("a modifier click with tabs off opens the chat in the main view", () => {
    expect(resolveChatOpen(request({ newTab: true }))).toEqual({ kind: "navigate" })
  })

  test("a modifier click on the page's own chat is still a modifier click", () => {
    expect(resolveChatOpen(request({ chatId: "main", newTab: true, tabsEnabled: true }))).toEqual({ kind: "background-tab" })
  })

  test("a reference to the chat the main view is showing opens nothing", () => {
    expect(resolveChatOpen(request({ chatId: "main" }))).toEqual({ kind: "stay" })
    // Nor with another chat in the previewer: the click was not in it.
    expect(resolveChatOpen(request({ chatId: "main", preview: { chatId: "other", back: [] } }))).toEqual({ kind: "stay" })
  })

  test("on the graph's page the page's own chat is navigated to", () => {
    expect(resolveChatOpen(request({ chatId: "main", pageShowsTranscript: false }))).toEqual({ kind: "navigate" })
  })

  test("the previewed chat's reference to the page's chat closes the previewer", () => {
    const preview = { chatId: "other", back: [] }
    expect(resolveChatOpen(request({ chatId: "main", from: "preview", preview }))).toEqual({ kind: "close-preview" })
    expect(resolveChatOpen(request({ chatId: "main", from: "preview", preview, pageShowsTranscript: false })))
      .toEqual({ kind: "close-preview" })
  })

  test("a chat clicked inside the previewer replaces it and leaves a way back", () => {
    expect(resolveChatOpen(request({
      chatId: "second",
      from: "preview",
      preview: { chatId: "first", back: [] },
    }))).toEqual({ kind: "preview", back: ["first"] })
    expect(resolveChatOpen(request({
      chatId: "third",
      from: "preview",
      preview: { chatId: "second", back: ["first"] },
    }))).toEqual({ kind: "preview", back: ["first", "second"] })
  })

  test("a chat already on the trail is gone back to", () => {
    expect(resolveChatOpen(request({
      chatId: "first",
      from: "preview",
      preview: { chatId: "third", back: ["first", "second"] },
    }))).toEqual({ kind: "preview", back: [] })
    expect(resolveChatOpen(request({
      chatId: "second",
      from: "preview",
      preview: { chatId: "third", back: ["first", "second"] },
    }))).toEqual({ kind: "preview", back: ["first"] })
  })

  test("a chat opened from the main view starts the trail over", () => {
    expect(resolveChatOpen(request({
      chatId: "sibling",
      preview: { chatId: "second", back: ["first"] },
    }))).toEqual({ kind: "preview", back: [] })
  })

  test("opening the chat already previewed keeps its trail", () => {
    const preview = { chatId: "second", back: ["first"] }
    expect(resolveChatOpen(request({ chatId: "second", preview }))).toEqual({ kind: "preview", back: ["first"] })
    expect(resolveChatOpen(request({ chatId: "second", from: "preview", preview })))
      .toEqual({ kind: "preview", back: ["first"] })
  })
})

describe("chatIdFromChatPath", () => {
  test("reads the id out of a chat route", () => {
    expect(chatIdFromChatPath("/chat/abc-123")).toBe("abc-123")
    expect(chatIdFromChatPath("/chat/abc-123/")).toBe("abc-123")
    expect(chatIdFromChatPath("/chat/abc_123?x=1#top")).toBe("abc_123")
  })

  test("is null for anything else", () => {
    expect(chatIdFromChatPath("/graph/abc")).toBeNull()
    expect(chatIdFromChatPath("/chat/")).toBeNull()
  })
})
