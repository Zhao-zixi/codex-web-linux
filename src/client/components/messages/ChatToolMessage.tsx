import { useMemo, useRef, type KeyboardEvent } from "react"
import { Loader2, MessageCircle } from "lucide-react"
import { toMessagePreview } from "../../../shared/message-preview"
import { CHAT_TOOL_NAMES } from "../../../shared/tools"
import { getThreadDetailLabel } from "../../lib/thread-detail-label"
import { cn, normalizeChatId } from "../../lib/utils"
import { useChatReferenceActions, useSidebarThread } from "../chat-ui/chat-reference"
import { SidebarChatHoverCard } from "../chat-ui/sidebar/ChatHoverCard"
import { ThreadRowMenu } from "../chat-ui/sidebar/ThreadRow"
import { ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { useNow } from "../chat-ui/widgets/TasksWidget"
import { text, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_CLASS, TOOL_CARD_WIDTH_CLASS, toolCardErrorText, useToolCardPayload } from "./tool-card"
import type { ProcessedToolCall } from "./types"

/**
 * The card for a chat an agent started or messaged (`create_chat`,
 * `fork_chat`, `send_message`), where the tool call sits in the transcript.
 *
 * It is that chat's row, lifted out of the sidebar: the same status glyph,
 * the same title shimmering while it runs, the same right-click menu and the
 * same hover card. The row says how the chat is doing; the line under it says
 * what this call did to it and with what words. A click opens the chat.
 *
 * Its status is live, not a record of the call. A chat started an hour ago
 * that is still running still spins, and one that finished shows that it has.
 */

type ChatToolCall = Extract<ProcessedToolCall, { toolKind: "chat" | "unknown_tool" }>

/**
 * Whether a tool call is one this card draws. By kind, and by name for a call
 * recorded before the kind existed: those are filed as unknown tools, with
 * their input and result left in the payload sidecar.
 */
export function isChatToolCall(message: ProcessedToolCall): message is ChatToolCall {
  return message.toolKind === "chat"
    || (message.toolKind === "unknown_tool" && CHAT_TOOL_NAMES.includes(message.toolName))
}

/** What the call did, in the words a person would use for doing it themselves. */
function describeCall(message: ChatToolCall, input: Record<string, unknown>, result: Record<string, unknown> | null): string {
  if (message.toolName === "fork_chat") return "Forked"
  if (message.toolName === "send_message") {
    if (input.delivery === "steer") return "Interrupted with"
    // Known only once the call returns: whether the message started a turn or
    // is waiting behind one.
    return result?.started === false ? "Queued" : "Sent"
  }
  return input.subchat === false ? "Started a chat" : "Started a sub-chat"
}

export function ChatToolMessage({ message }: { message: ChatToolCall }) {
  const actions = useChatReferenceActions()
  const { input, rawResult, result } = useToolCardPayload(message)
  // A new chat's id comes back in the result. A message names its chat going in.
  const chatId = text(result?.chatId) ?? (message.toolName === "send_message" ? text(input.chatId) : null)
  const thread = useSidebarThread(chatId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const running = thread?.row.status === "running" || thread?.row.status === "starting"
  const now = useNow(running)
  // One array for as long as the chat is unchanged: the hover card is memoized on it.
  const threads = useMemo(() => (thread ? [thread] : []), [thread])

  if (message.isError) {
    return <p role="alert" className="text-sm text-destructive">{toolCardErrorText(rawResult, "The chat could not be reached.")}</p>
  }

  const pending = !message.resultEntryId
  const sent = text(input.message)
  const caption = [describeCall(message, input, result), sent ? toMessagePreview(sent) : null].filter(Boolean).join(" · ")
  const captionLine = <p className={TOOL_CARD_CAPTION_CLASS}>{caption}</p>

  // Before the call returns there is no chat to show yet, and after it one
  // the sidebar has not heard of (a snapshot behind, or deleted since). Both
  // draw the same card with what the call itself knows, and nothing to open.
  if (!thread || !actions || !chatId) {
    const title = text(result?.title) ?? text(input.title) ?? (sent ? toMessagePreview(sent) : "Chat")
    return (
      <div className={cn(TOOL_CARD_CLASS, TOOL_CARD_WIDTH_CLASS)}>
        <div className="flex min-w-0 items-center gap-2.5">
          {pending
            ? <Loader2 className="size-3.5 shrink-0 animate-spin text-logo" />
            : <MessageCircle className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn("min-w-0 truncate", !pending && "text-muted-foreground")}>{title}</span>
        </div>
        {captionLine}
      </div>
    )
  }

  const open = () => actions.onOpenChat(chatId)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
    event.preventDefault()
    open()
  }

  return (
    <div ref={containerRef} className={TOOL_CARD_WIDTH_CLASS}>
      <ThreadRowMenu thread={thread} archived={thread.archived} editorLabel={actions.editorLabel} {...actions.menu}>
        <div
          role="button"
          tabIndex={0}
          // What the hover card finds the card under the pointer by.
          data-chat-id={normalizeChatId(chatId)}
          onClick={open}
          onKeyDown={onKeyDown}
          className={cn(
            TOOL_CARD_CLASS,
            // The border lights at once, as a row's highlight does, and stays
            // lit while the hover card it opened is up. The press is the only
            // thing that moves: a 1.5% give, in and out on the app's curve.
            "cursor-pointer select-none outline-none hover:border-muted-foreground/40 data-[hover-card-open]:border-muted-foreground/40 focus-visible:ring-2 focus-visible:ring-ring",
            "transition-[scale] duration-150 ease-snappy active:scale-[0.985] motion-reduce:transition-none motion-reduce:active:scale-100",
          )}
        >
          <div className="flex min-w-0 items-center gap-2.5">
            <ThreadRowContent
              thread={thread}
              showStatus
              // A card is one chat someone pointed at, not a list to scan, so
              // its title never recedes.
              dimIdleTitles={false}
              detailLabel={getThreadDetailLabel(thread, "project-scoped", now)}
            />
          </div>
          {captionLine}
        </div>
      </ThreadRowMenu>
      <SidebarChatHoverCard
        containerRef={containerRef}
        threads={threads}
        side="bottom"
        // Just clear of the card, as under a tab.
        sideOffset={6}
        {...actions.card}
      />
    </div>
  )
}
