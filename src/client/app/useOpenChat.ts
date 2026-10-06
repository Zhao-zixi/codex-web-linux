import { useCallback } from "react"
import { useNavigate } from "react-router-dom"
import { isNewTabClick } from "../lib/background-open"
import { buildChatJumpLocationState, type ChatJumpTarget } from "../lib/chat-navigation"
import { chatIdFromChatPath, resolveChatOpen } from "../lib/chat-open"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useChatTabsStore } from "../stores/chatTabsStore"
import { getChatViewer, useViewerStore } from "../stores/viewerStore"

export interface OpenChatOptions {
  /**
   * Where the click was. "preview" for anything inside the previewed chat,
   * so a chat opened from there keeps a way back. Defaults to "page".
   */
  from?: "page" | "preview"
  /** A message to land on, as the hover card's clickable previews ask for. */
  jump?: ChatJumpTarget
  /**
   * "tab" skips the previewer whatever the chat is: the previewer's own
   * "Open in tab", and the menu item of the same name.
   */
  target?: "tab"
}

export type OpenChat = (chatId: string, options?: OpenChatOptions) => void

/**
 * Whether the main view is showing this chat's transcript: the chat is the
 * page's and the route is its chat route. On the graph's page (`/graph/<id>`)
 * the chat is the page's but its tree is drawn where the transcript would be.
 *
 * Read off the address, once, from inside a click handler or a render that a
 * route change redoes anyway: the hook below must not re-render its callers
 * for every navigation.
 */
export function isChatInMainView(chatId: string): boolean {
  if (typeof window === "undefined") return false
  return useViewerStore.getState().chatKey === chatId && chatIdFromChatPath(window.location.pathname) === chatId
}

/**
 * Open a chat from inside another chat's view: THE entry point for a click on
 * a Kanna chat link, a delegation card, a reply quote, a Tasks row, a hover
 * card's Open, a graph node. The chat opens in the previewer beside the one
 * you are in, whatever it is to it; the rule is `resolveChatOpen` in
 * lib/chat-open.
 *
 * A new surface that can open a chat calls this (or `onOpenChat` of
 * `useChatReferenceActions`, which is this) and gets the behaviour whole:
 * the previewer, Cmd/Ctrl-click and middle-click for a tab, and a way back
 * from one previewed chat to the last. Reads the click in flight for its
 * modifier, so call it from the click handler itself.
 *
 * Not for the lists a chat is navigated from. The sidebar, the tab bar and
 * the command palette are how the chat in the main view is changed.
 */
export function useOpenChat(): OpenChat {
  const navigate = useNavigate()
  return useCallback<OpenChat>((chatId, options) => {
    const viewerStore = useViewerStore.getState()
    const pageChatId = viewerStore.chatKey || null
    const item = getChatViewer()?.item
    const preview = item?.kind === "chat" ? { chatId: item.chatId, back: item.back ?? [] } : null
    const goTo = () => navigate(`/chat/${chatId}`, options?.jump ? { state: buildChatJumpLocationState(options.jump) } : undefined)

    if (options?.target === "tab") {
      // The chat moves to the main view. Left open, the previewer would show
      // it again beside this chat the next time you were here.
      if (preview?.chatId === chatId) viewerStore.close()
      // Already there: going to it again would only add a step to Back.
      if (!isChatInMainView(chatId) || options.jump) goTo()
      return
    }

    const action = resolveChatOpen({
      chatId,
      pageChatId,
      pageShowsTranscript: pageChatId !== null && isChatInMainView(pageChatId),
      preview,
      from: options?.from ?? "page",
      newTab: isNewTabClick(),
      tabsEnabled: useAppSettingsStore.getState().settings?.chatTabsEnabled === true,
      canPreview: viewerStore.chatPreviewHosts > 0,
    })

    if (action.kind === "background-tab") {
      useChatTabsStore.getState().open(chatId, pageChatId)
    } else if (action.kind === "close-preview" || action.kind === "stay") {
      // The chat is the one in the main view. Shown by clearing the previewer
      // from over it; and when a message in it was asked for, by scrolling
      // there, which is the same one-shot jump the sidebar's card sends.
      if (action.kind === "close-preview") viewerStore.close()
      if (options?.jump) goTo()
    } else if (action.kind === "preview") {
      // A trail that began at the graph still ends there: stepping from one
      // chat to the next inside the previewer carries it along. A chat opened
      // from the page starts a new trail, with no graph behind it.
      const graph = options?.from === "preview" && item?.kind === "chat" ? item.graph : undefined
      viewerStore.open({
        kind: "chat",
        chatId,
        ...(action.back.length > 0 ? { back: action.back } : {}),
        ...(graph ? { graph } : {}),
      })
      if (options?.jump) viewerStore.setChatJump(chatId, options.jump)
    } else {
      goTo()
    }
  }, [navigate])
}
