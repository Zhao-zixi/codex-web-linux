import { useMemo, useState } from "react"
import type { MessageSource, QueuedChatMessage } from "../../../shared/types"
import type { ReportSection } from "../../../shared/report-sections"
import { stripSystemMessages } from "../../../shared/message-preview"
import { cn } from "../../lib/utils"
import { Button } from "../ui/button"
import { CLAMP_LINES, ClampedMessageText, FOLD_SURFACE_ATTRIBUTE } from "./ClampedMessageText"
import { AdoptionNotice, isAdoptionNotice, ReplyQuoteRow, SectionQuote, sourcedSections, type PromptDelegation } from "./SourcedMessage"
import { UserMessageAttachments } from "./UserMessage"
import { ArrowUp, X } from "lucide-react"

interface QueuedUserMessageProps {
  message: QueuedChatMessage
  /** For a queued report: the calls in the transcript it answers. See SourcedMessage. */
  delegations?: readonly PromptDelegation[]
  /** Each may return the command's promise, which is how long the row stays dimmed. */
  onRemove: () => void | Promise<void>
  onSendNow: () => void | Promise<void>
}

/** The dashed outline that says a message is waiting, on either side of the column. */
const QUEUED_BUBBLE_CLASS = "rounded-2xl border border-dashed border-border bg-transparent prose prose-sm prose-invert text-left text-primary"

/**
 * What both controls share. The properties are named because the shared
 * Button's own transition is `all`, which would also ease the corner offsets
 * that place Remove. A press gives by 5%: at 18 and 24px, the 3% a full-size
 * button gives is under a pixel and reads as nothing.
 */
const QUEUED_CONTROL_CLASS = "transition-[color,background-color,scale] duration-150 ease-snappy active:scale-[0.95] motion-reduce:transition-none motion-reduce:active:scale-100"

function SendNowButton({ onSendNow, disabled }: { onSendNow: () => void; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="default"
      size="none"
      aria-label="Send now"
      disabled={disabled}
      className={cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 24px. The `before` layer takes the press: 32px, which
        // is as far as it can reach without leaving the bubble.
        "relative shrink-0 rounded-full size-[24px] bg-muted text-muted-foreground border border-primary/10 group-hover:!text-primary hover:bg-muted/60 before:absolute before:-inset-1 before:rounded-full before:content-['']",
      )}
      onClick={onSendNow}
    >
      <ArrowUp className="size-3.5"/>
    </Button>
  )
}

/**
 * Takes the message out of the queue. On the bubble's corner that faces the
 * middle of the column, whichever side the bubble is on.
 *
 * Always there, not only under the pointer: a control that appears on hover
 * does not exist on a touch screen, and on a desktop it has to be found
 * before it can be used.
 */
function RemoveButton({ corner, onRemove, disabled }: { corner: "start" | "end"; onRemove: () => void; disabled: boolean }) {
  return (
    <Button
      type="button"
      variant="none"
      size="none"
      aria-label="Remove from queue"
      disabled={disabled}
      className={cn(
        QUEUED_CONTROL_CLASS,
        // The circle is 18px. The `before` layer is what takes the press:
        // 30px, so the target is comfortable without the mark growing.
        "!p-0.5 border rounded-full text-xs font-medium text-muted-foreground hover:text-foreground gap-0.5 absolute top-0 bg-surface -translate-y-[28%] before:absolute before:-inset-1.5 before:rounded-full before:content-['']",
        corner === "start" ? "left-0 -translate-x-[28%]" : "right-0 translate-x-[28%]",
      )}
      onClick={onRemove}
    >
      <X className="size-3"/>
    </Button>
  )
}

interface QueuedFormProps {
  message: QueuedChatMessage
  delegations?: readonly PromptDelegation[]
  /** A press on Remove or Send now is on its way to the server. */
  busy: boolean
  onRemove: () => void
  onSendNow: () => void
}

/**
 * Dims while a press is being carried out. The queue is the server's: the
 * message stays where it is until the server says it has gone, and without
 * this a press on a slow connection looks like one that missed.
 */
const QUEUED_ROW_CLASS = "flex flex-col gap-2 py-2 transition-opacity duration-150 ease-out motion-reduce:transition-none"

export function QueuedUserMessage({ message, delegations, onRemove, onSendNow }: QueuedUserMessageProps) {
  const [busy, setBusy] = useState(false)
  // Held until the command settles, not until the row goes: if the server
  // refuses, the message is still queued and has to be usable again.
  const carryOut = (action: () => void | Promise<void>) => () => {
    setBusy(true)
    void Promise.resolve(action()).finally(() => setBusy(false))
  }
  const form = { message, delegations, busy, onRemove: carryOut(onRemove), onSendNow: carryOut(onSendNow) }
  return message.source
    ? <QueuedSourcedMessage {...form} source={message.source} />
    : <QueuedTypedMessage {...form} />
}

function QueuedTypedMessage({ message, busy, onRemove, onSendNow }: QueuedFormProps) {
  // What the sent message will show: without the parts meant for the agent.
  const content = stripSystemMessages(message.content)
  return (
    <div className={cn(QUEUED_ROW_CLASS, "items-end", busy && "opacity-60")}>
      <UserMessageAttachments attachments={message.attachments} />
      <div className="flex max-w-[85%] sm:max-w-[80%] flex-col items-end">
        {/* Rendered even for an attachment-only message: the bubble carries
            Send now and Remove, and without it an image queued with no text
            could not be sent early or taken back. */}
        <div className="relative group">
          {/* min-w-0 on the grid and on the text track: a `1fr` track sizes to
              min-content by default, so an unbreakable token (a long URL)
              widens the bubble past the column instead of wrapping the way it
              does in UserMessage. */}
          <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(QUEUED_BUBBLE_CLASS, "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-end gap-2.5 pl-3.5 pr-1.5 py-1.5")}>
            <div className="min-w-0">
              {content ? (
                <ClampedMessageText text={content} lines={CLAMP_LINES.typed} />
              ) : (
                <p className="text-muted-foreground">Queued</p>
              )}
            </div>
            <SendNowButton onSendNow={onSendNow} disabled={busy} />
          </div>
          <RemoveButton corner="start" onRemove={onRemove} disabled={busy} />
        </div>
      </div>
    </div>
  )
}

/**
 * A queued message the user did not type: a report or an automation that
 * arrived mid-turn. What it will be once delivered (SourcedMessage) in the
 * dashed outline of something still waiting: on the same side, so it does not
 * cross the column when its turn starts, with the same quote over it on the
 * same line, and the same clamped text.
 *
 * A typed prompt's queued bubble, turned around: Send now leads the text
 * instead of trailing it, and Remove sits on the opposite corner. The quote
 * can reach over that corner, and the line between them keeps it 20px up,
 * well clear of Remove and of the 6px around it that also takes a press.
 *
 * A report covering several sub-chats is a bubble for each, as it will be
 * delivered, each under its own quote. It is still one message to send or
 * remove, so there is one of each control: Remove on the first bubble, where
 * a reader starts, and Send now in the last, where the message ends.
 */
function QueuedSourcedMessage({ message, source, delegations, busy, onRemove, onSendNow }: QueuedFormProps & { source: MessageSource }) {
  const sections = useMemo((): ReportSection[] => {
    const parts = sourcedSections(message.content, source)
    if (parts.length > 0) return parts
    // Nothing to read: a report on sub-chats that were stopped before they
    // said anything. It still waits its turn, and still says who it is from.
    return [{ chatId: source.kind === "report" && source.chatIds.length === 1 ? source.chatIds[0]! : null, body: "", status: null }]
  }, [message.content, source])

  return (
    <div className={cn(QUEUED_ROW_CLASS, "items-start", busy && "opacity-60")}>
      <UserMessageAttachments attachments={message.attachments} align="start" />
      {sections.map((section, index) => {
        const first = index === 0
        const last = index === sections.length - 1
        const notice = isAdoptionNotice(section)
        const text = notice
          ? <AdoptionNotice section={section} />
          : section.body
            ? <ClampedMessageText text={section.body} lines={CLAMP_LINES.sent} />
            : <p className="text-muted-foreground">Queued</p>
        return (
          <div key={index} className="flex min-w-0 max-w-[85%] flex-col items-start sm:max-w-[80%]">
            {/* A notice is the news itself, with no one to quote. */}
            {notice ? null : (
              <ReplyQuoteRow>
                <SectionQuote section={section} source={source} delegations={delegations} />
              </ReplyQuoteRow>
            )}
            <div className="relative group min-w-0 max-w-full">
              <div {...{ [FOLD_SURFACE_ATTRIBUTE]: "" }} className={cn(
                QUEUED_BUBBLE_CLASS,
                "min-w-0 py-1.5",
                last ? "grid grid-cols-[auto_minmax(0,1fr)] items-end gap-2.5 pl-1.5 pr-3.5" : "px-3.5",
              )}>
                {last ? <SendNowButton onSendNow={onSendNow} disabled={busy} /> : null}
                <div className="min-w-0">{text}</div>
              </div>
              {first ? <RemoveButton corner="end" onRemove={onRemove} disabled={busy} /> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
