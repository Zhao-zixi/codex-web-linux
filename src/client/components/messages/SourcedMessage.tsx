import { useMemo, useRef, type ReactNode } from "react"
import { CalendarClock, CornerUpRight, Split } from "lucide-react"
import type { ChatAttachment, HydratedTranscriptMessage, MessageSource } from "../../../shared/types"
import { stripSystemMessages } from "../../../shared/message-preview"
import { ADOPTED_REPORT_STATUS, isInterimReportStatus, splitReportSections, type ReportSection } from "../../../shared/report-sections"
import { cn } from "../../lib/utils"
import { useChatReferenceActions, useChatSchedules, useSidebarThread } from "../chat-ui/chat-reference"
import { formatScheduleTrigger } from "../chat-ui/widgets/SchedulesWidget"
import { CLAMP_LINES, ClampedMessageText, FOLD_SURFACE_ATTRIBUTE } from "./ClampedMessageText"
import { ChatReplyQuote, inlineChatToolExcerpt, inlineChatToolTarget, isChatToolCall, type ChatToolCall } from "./ChatToolMessage"
import { ScheduleCardBox } from "./ScheduleToolMessage"
import { TOOL_QUOTE_CLASS } from "./tool-card"
import { USER_BUBBLE_CLASS, UserMessageAttachments } from "./UserMessage"

/**
 * A message that reached the chat as a prompt without the user typing it: a
 * sub-chat's report, a message another chat's agent sent, or a schedule
 * firing (`MessageSource`).
 *
 * It keeps the bubble of a prompt, because to the agent that is what it is.
 * It sits on the agent's side of the column, because the user did not write
 * it. Over the bubble it quotes where it came from, the way a messaging app
 * quotes what a reply is to: the row of the chat at the other end
 * (`ChatReplyQuote`), or the schedule's card, joined to the bubble by a short
 * line (`ReplyQuoteRow`). The bubble holds only the text, held to a few lines as
 * every prompt's is (ClampedMessageText).
 */

/** The call in this chat's transcript that a sub-chat's report answers. */
export interface PromptDelegation {
  chatId: string
  call: ChatToolCall
}

/**
 * Keep `latest` pointing at the newest call to each chat, one message at a
 * time. A report answers the last thing its sub-chat was sent: the call that
 * started it, or a message sent to it since.
 */
export function noteDelegation(latest: Map<string, ChatToolCall>, message: HydratedTranscriptMessage) {
  if (message.kind !== "tool" || !isChatToolCall(message)) return
  const chatId = inlineChatToolTarget(message)
  if (chatId) latest.set(chatId, message)
}

/** The calls a message from `source` answers, of those seen so far. */
export function delegationsFor(latest: ReadonlyMap<string, ChatToolCall>, source: MessageSource | undefined): PromptDelegation[] | undefined {
  if (source?.kind !== "report" || latest.size === 0) return undefined
  const found: PromptDelegation[] = []
  for (const chatId of source.chatIds) {
    const call = latest.get(chatId)
    if (call) found.push({ chatId, call })
  }
  return found.length > 0 ? found : undefined
}

/**
 * What a sourced message shows, one part per bubble. A report covering
 * several sub-chats is several parts, each beside the chat that said it.
 */
export function sourcedSections(content: string, source: MessageSource): ReportSection[] {
  if (source.kind !== "report") {
    const body = stripSystemMessages(content)
    return body ? [{ chatId: null, body, status: null }] : []
  }
  const only = source.chatIds.length === 1 ? source.chatIds[0]! : null
  return splitReportSections(content, source.chatIds).map((section) => ({ ...section, chatId: section.chatId ?? only }))
}

/**
 * Where a message came from, as a quote over its bubble.
 *
 * The live thing where there is one: the other chat's row, the schedule's
 * card. Each falls back to a plain line that still says what kind of sender
 * it was, for a chat the sidebar has not heard of, a schedule deleted since,
 * and the exported viewer, which has neither.
 */
export function SourceQuote({ source, chatId, delegations, interim = false }: {
  source: MessageSource
  /** For a report: the sub-chat this part is from. */
  chatId: string | null
  delegations?: readonly PromptDelegation[]
  /** For a report: the sub-chat had not finished when it sent this. */
  interim?: boolean
}) {
  const schedules = useChatSchedules()

  if (source.kind === "schedule") {
    const schedule = schedules?.schedules.find((candidate) => candidate.id === source.scheduleId)
    if (schedule && schedules) {
      return (
        <ScheduleCardBox
          schedule={schedule}
          context={schedules}
          // No preview of the schedule's message, as its own card has: the
          // message is what the bubble is showing.
          caption={`Automation · ${formatScheduleTrigger(schedule.trigger)}`}
          quote
        />
      )
    }
    return (
      <div className={TOOL_QUOTE_CLASS}>
        <div className="flex min-w-0 items-center gap-2.5">
          <CalendarClock className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground">Automation</span>
        </div>
      </div>
    )
  }

  if (source.kind === "agent") return <ChatReplyQuote chatId={source.chatId} title="Another agent" />

  // What the sub-chat was asked, where the call that asked it is loaded. The
  // quote is the sub-chat's row either way.
  const delegation = chatId ? delegations?.find((candidate) => candidate.chatId === chatId) : undefined
  return (
    <ChatReplyQuote
      chatId={chatId}
      title={chatId ? "Sub-chat" : "Sub-chats"}
      excerpt={delegation ? inlineChatToolExcerpt(delegation.call) : null}
      interim={interim}
    />
  )
}

/** A chat's name in a sentence, opening the chat where there is one to open. */
function ChatName({ chatId, fallback }: { chatId: string | null | undefined; fallback: string }) {
  const actions = useChatReferenceActions()
  const thread = useSidebarThread(chatId)
  if (!thread || !actions || !chatId) return <span>{thread?.title ?? fallback}</span>
  return (
    <button
      type="button"
      onClick={() => actions.onOpenChat(chatId)}
      className="cursor-pointer rounded-sm font-medium text-foreground/80 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {thread.title}
    </button>
  )
}

/**
 * The news that a sub-chat this chat was waiting on now reports to another:
 * the part of a report with `status: "adopted"`.
 *
 * A line, not a bubble. The sub-chat said nothing here, and its quote over
 * an empty bubble would claim it had. But the line has to be there: the
 * chat was waiting on a result, and without it the wait just ends, with
 * nothing on the page to say why. Both chats are named so either can be
 * opened, the adopter because that is where the result went.
 */
export function AdoptionNotice({ section }: { section: ReportSection }) {
  return (
    <p className="not-prose flex min-w-0 items-start gap-2 text-sm leading-5 text-muted-foreground">
      <Split aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">
        <ChatName chatId={section.chatId} fallback="A sub-chat" />
        {" was adopted by "}
        <ChatName chatId={section.adoptedByChatId} fallback="another chat" />
        {". Its result will not arrive here."}
      </span>
    </p>
  )
}

export function isAdoptionNotice(section: ReportSection) {
  return section.status === ADOPTED_REPORT_STATUS && !section.body
}

/** A quote's own width: what it says, to a limit that keeps a long excerpt from widening the message. */
export const REPLY_QUOTE_WIDTH_CLASS = "min-w-0 max-w-96"

/**
 * A quote over the bubble it belongs to, with a short line joining them:
 *
 *   [ quoted chat      ]
 *     |
 *   [ the message                   ]
 *
 * The quote starts at the bubble's left edge and is as wide as what it says,
 * up to 24rem. It is not tied to the bubble's width: over a short message it
 * runs on past the bubble's far edge.
 *
 * The line is a 3px stroke with round ends, 14px long, a shape of its own
 * between two 1px outlines. It stops its own width short of each, so the
 * quote stands 20px off the bubble: 3, the line, 3. A thick line butted
 * against a hairline reads as a collision, and with the gaps it reads as a
 * link. It is 18px in from the shared left edge, which is 2 clear of where
 * the bubble's 16px corner straightens out and 6 clear of the quote's 12.
 *
 * It takes the border colour at full strength, which at this weight is a
 * soft grey: firmer than the quote's half-strength outline, and still
 * quieter than any text.
 */
export function ReplyQuoteRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 max-w-full flex-col items-start">
      <div className={REPLY_QUOTE_WIDTH_CLASS}>{children}</div>
      <span aria-hidden className="my-[3px] ml-[18px] h-[14px] w-[3px] rounded-full bg-border" />
    </div>
  )
}

/** The quote for one part of a sourced message. */
export function SectionQuote({ section, source, delegations }: {
  section: ReportSection
  source: MessageSource
  delegations?: readonly PromptDelegation[]
}) {
  return <SourceQuote source={source} chatId={section.chatId} delegations={delegations} interim={isInterimReportStatus(section.status)} />
}

/** One part of a delivered message: its quote, the line, and its bubble. */
function SourcedPart({ section, source, delegations, steered, flash }: {
  section: ReportSection
  source: MessageSource
  delegations?: readonly PromptDelegation[]
  steered: boolean
  flash: boolean
}) {
  const partRef = useRef<HTMLDivElement | null>(null)
  return (
    // Each child keeps its own width: the bubble is as wide as its text and
    // the quote as wide as its own, whichever is the longer.
    <div ref={partRef} className="flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]">
      <ReplyQuoteRow>
        <SectionQuote section={section} source={source} delegations={delegations} />
      </ReplyQuoteRow>
      <div className="flex min-w-0 max-w-full items-center gap-2">
        <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(USER_BUBBLE_CLASS, "px-3.5 py-1.5", flash && "kanna-jump-flash")}>
          <ClampedMessageText text={section.body} lines={CLAMP_LINES.sent} scopeRef={partRef} />
        </div>
        {/* After the bubble and turned around, where a typed prompt has it
            before: on the side that faces the middle of the column. */}
        {steered ? (
          <span
            aria-label="Sent mid-turn"
            role="img"
            title="Sent mid-turn"
            className="shrink-0 text-muted-foreground"
          >
            <CornerUpRight className="h-4 w-4" />
          </span>
        ) : null}
      </div>
    </div>
  )
}

interface Props {
  content: string
  source: MessageSource
  attachments?: ChatAttachment[]
  steered?: boolean
  /** Light the bubbles: a jump just landed on this message. See UserMessage. */
  flash?: boolean
  delegations?: readonly PromptDelegation[]
}

export function SourcedMessage({ content, source, attachments = [], steered = false, flash = false, delegations }: Props) {
  const sections = useMemo(() => sourcedSections(content, source), [content, source])

  return (
    <div className="flex flex-col items-start gap-2">
      <UserMessageAttachments attachments={attachments} align="start" />
      {sections.map((section, index) => isAdoptionNotice(section) ? (
        // Level with a bubble's text, 14px in, so a notice between two
        // bubbles reads as part of the same column.
        <div key={index} className="max-w-[85%] px-3.5 sm:max-w-[80%]">
          <AdoptionNotice section={section} />
        </div>
      ) : (
        <SourcedPart
          key={index}
          section={section}
          source={source}
          delegations={delegations}
          steered={steered && index === 0}
          flash={flash}
        />
      ))}
    </div>
  )
}
