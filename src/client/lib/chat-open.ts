/**
 * What opening a chat from inside another chat's view does: a click on a
 * Kanna chat link, a delegation card, a reply quote, a Tasks row, a node of
 * the graph.
 *
 * It opens in the previewer, beside the chat you are reading, whatever the
 * two are to each other: a sub-chat, its parent, or a chat that only gets a
 * mention. Following a reference never costs you your place in the chat that
 * made it. The chat in the main view changes only when you change it, from
 * the lists a chat is navigated from (the sidebar, the tab bar, the command
 * palette), which do not come through here.
 *
 * The decision only. `useOpenChat` gathers what it needs and carries it out,
 * and is the one function every such click calls. Kept React-free for tests.
 */

/** What the previewer is showing, and the chats that lead back from it. */
export interface ChatPreviewTrail {
  chatId: string
  /** Oldest first: the chat a Back from this one returns to is the last. */
  back: readonly string[]
}

export interface ChatOpenRequest {
  chatId: string
  /** The page's chat: the one its composer sends to. Null on a page without one. */
  pageChatId: string | null
  /**
   * Whether the main view is showing the page's chat as a transcript. False
   * on the graph's page, which is on a chat but draws its tree in its place.
   */
  pageShowsTranscript: boolean
  /** What the previewer is on, or null while it holds no chat. */
  preview: ChatPreviewTrail | null
  /** Where the click was: in the main view, or in the previewed chat. */
  from: "page" | "preview"
  /** Cmd/Ctrl held, or the middle button: "not here, in a tab". */
  newTab: boolean
  /** The Chat Tabs setting. */
  tabsEnabled: boolean
  /** Whether this page has a previewer to open a chat in. */
  canPreview: boolean
}

export type ChatOpenAction =
  /** Show it in the previewer. `back` is the trail that leads back from it. */
  | { kind: "preview"; back: string[] }
  /** Go to it in the main view. */
  | { kind: "navigate" }
  /** Give it a tab and stay where you are. */
  | { kind: "background-tab" }
  /** It is the chat already in the main view: closing the previewer shows it. */
  | { kind: "close-preview" }
  /** It is the chat already in the main view, in plain sight: nothing to open. */
  | { kind: "stay" }

export function resolveChatOpen(request: ChatOpenRequest): ChatOpenAction {
  const { chatId, preview } = request

  // Asked for by modifier, a tab outranks everything, as on a browser's link.
  // With tabs off there is no tab to give, so the chat opens in the main view.
  if (request.newTab) return { kind: request.tabsEnabled ? "background-tab" : "navigate" }

  // The page's own chat never opens in the previewer: it would be the same
  // chat twice, with two composers and one draft between them.
  if (chatId === request.pageChatId) {
    // Clicked in the previewed chat (its link back to its parent, say), the
    // chat is right there under or beside the previewer.
    if (request.from === "preview" && preview) return { kind: "close-preview" }
    // Clicked in its own transcript, it is what you are looking at. On the
    // graph's page it is not, and its node is the way to its transcript.
    return { kind: request.pageShowsTranscript ? "stay" : "navigate" }
  }

  if (!request.canPreview) return { kind: "navigate" }

  // Opened from the main view, a preview starts over: its trail is of the
  // clicks made inside the previewer, and this was not one.
  if (request.from === "page" || !preview) {
    return { kind: "preview", back: preview?.chatId === chatId ? [...preview.back] : [] }
  }
  if (preview.chatId === chatId) return { kind: "preview", back: [...preview.back] }

  // A chat already on the trail (a sub-chat's link to its parent, two levels
  // down) is gone back to, not stacked on top of itself.
  const seenAt = preview.back.indexOf(chatId)
  if (seenAt !== -1) return { kind: "preview", back: preview.back.slice(0, seenAt) }
  return { kind: "preview", back: [...preview.back, preview.chatId] }
}

/** The chat id a `/chat/<id>` path names (see `parseChatLink`), or null. */
export function chatIdFromChatPath(path: string): string | null {
  return /^\/chat\/([a-zA-Z0-9_-]+)/.exec(path)?.[1] ?? null
}
