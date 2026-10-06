import { PanelRight, SquareArrowOutUpRight } from "lucide-react"
import type { ReactNode } from "react"
import type { SidebarThread } from "../../lib/thread-sections"
import { isChatInMainView } from "../../app/useOpenChat"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { useViewerStore } from "../../stores/viewerStore"
import { ContextMenuItem } from "../ui/context-menu"
import type { ChatReferenceActions } from "./chat-reference"

/**
 * The two ways to open a chat, at the head of its right-click menu wherever
 * it is shown inside another chat (its card in the transcript, its Tasks
 * row): in the previewer, which a click does anyway, and in the main view,
 * which otherwise takes Cmd/Ctrl-click to reach.
 *
 * Null for the chat the main view is already showing (a link to itself, or a
 * previewed chat's link back to it), which neither can open any further.
 * Null and not an empty fragment, so callers can hand the result straight to
 * a menu's `leadingItems`, which draws a separator after anything it gets.
 */
export function chatOpenMenuItems(thread: SidebarThread, actions: ChatReferenceActions): ReactNode {
  if (isChatInMainView(thread.chatId)) return null
  return <ChatOpenMenuItems chatId={thread.chatId} actions={actions} />
}

function ChatOpenMenuItems({ chatId, actions }: { chatId: string; actions: ChatReferenceActions }) {
  const chatTabsEnabled = useAppSettingsStore((store) => store.settings?.chatTabsEnabled === true)
  // The page's own chat has no preview to offer (on the graph's page, where
  // it is not also what the main view shows): only the way to its transcript.
  const isPageChat = useViewerStore((store) => store.chatKey === chatId)
  return (
    <>
      {isPageChat ? null : (
        <ContextMenuItem onSelect={() => actions.onOpenChat(chatId)}>
          <PanelRight className="size-3.5" />
          <span className="text-xs font-medium">Open in Preview</span>
        </ContextMenuItem>
      )}
      <ContextMenuItem onSelect={() => actions.onOpenChatInTab(chatId)}>
        <SquareArrowOutUpRight className="size-3.5" />
        <span className="text-xs font-medium">{chatTabsEnabled ? "Open in Tab" : "Open Chat"}</span>
      </ContextMenuItem>
    </>
  )
}
