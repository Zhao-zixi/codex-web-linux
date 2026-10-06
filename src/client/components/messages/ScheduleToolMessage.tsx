import { useRef } from "react"
import { CalendarClock, Loader2, Pencil } from "lucide-react"
import { toMessagePreview } from "../../../shared/message-preview"
import { SCHEDULE_TOOL_NAMES } from "../../../shared/tools"
import type { ChatSchedule, ScheduleTrigger } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { useChatSchedules, type ChatSchedulesValue } from "../chat-ui/chat-reference"
import {
  formatScheduleState,
  formatScheduleTrigger,
  ScheduleCard,
  TRIGGER_ICON,
  useMinuteClock,
} from "../chat-ui/widgets/SchedulesWidget"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { ListHoverCard } from "../ui/list-hover-card"
import { text, TOOL_CARD_CAPTION_CLASS, TOOL_CARD_CLASS, TOOL_CARD_WIDTH_CLASS, toolCardClasses, toolCardErrorText, useToolCardPayload } from "./tool-card"
import type { ProcessedToolCall } from "./types"

/**
 * The card for a schedule an agent set, changed or deleted (`set_schedule`,
 * `delete_schedule`), where the tool call sits in the transcript.
 *
 * It is that schedule's row from the Schedules widget, in a card: its name,
 * when it runs next, the same hover card with its recent runs, and the same
 * Edit. Like a chat's card it is live, so a schedule set an hour ago shows
 * when it runs next now, and one paused since shows that.
 *
 * Nothing here acts on a click, as in the widget: Edit writes into the
 * composer, which is not something to do by accident.
 */

type ScheduleToolCall = Extract<ProcessedToolCall, { toolKind: "schedule" | "unknown_tool" }>

/** By kind, and by name for a call recorded before the kind existed. See `isChatToolCall`. */
export function isScheduleToolCall(message: ProcessedToolCall): message is ScheduleToolCall {
  return message.toolKind === "schedule"
    || (message.toolKind === "unknown_tool" && SCHEDULE_TOOL_NAMES.includes(message.toolName))
}

/**
 * The trigger a call asked for, read from its input. For a card whose
 * schedule is not at hand: deleted since, or belonging to another chat.
 */
function requestedTrigger(input: Record<string, unknown>): ScheduleTrigger | null {
  if (typeof input.everyMinutes === "number") return { kind: "interval", everyMs: input.everyMinutes * 60_000 }
  if (typeof input.dailyAt === "string") {
    const weekdays = Array.isArray(input.weekdays) ? input.weekdays.filter((day): day is number => typeof day === "number") : undefined
    return { kind: "daily", timeOfDay: input.dailyAt, ...(weekdays?.length ? { weekdays } : {}) }
  }
  if (typeof input.inMinutes === "number" || typeof input.runAt === "string") return { kind: "once", at: 0 }
  return null
}

export function ScheduleToolMessage({ message }: { message: ScheduleToolCall }) {
  const context = useChatSchedules()
  const { input, rawResult, result } = useToolCardPayload(message)
  const deleted = message.toolName === "delete_schedule"
  const scheduleId = text(result?.scheduleId) ?? text(result?.deleted) ?? text(input.scheduleId)
  const schedule = !deleted && scheduleId ? context?.schedules.find((candidate) => candidate.id === scheduleId) ?? null : null

  if (message.isError) {
    return <p role="alert" className="text-sm text-destructive">{toolCardErrorText(rawResult, "The schedule could not be changed.")}</p>
  }

  // An id going in means a schedule that already existed.
  const verb = deleted ? "Deleted" : text(input.scheduleId) ? "Updated" : "Scheduled"

  if (!schedule || !context) {
    const pending = !message.resultEntryId
    const sent = text(result?.message) ?? text(input.message)
    const trigger = requestedTrigger(input)
    const title = text(result?.name) ?? text(input.name) ?? (sent ? toMessagePreview(sent) : "Schedule")
    const caption = [verb, trigger ? formatScheduleTrigger(trigger) : null, sent ? toMessagePreview(sent) : null].filter(Boolean).join(" · ")
    const Icon = trigger ? TRIGGER_ICON[trigger.kind] : CalendarClock
    return (
      <div className={cn(TOOL_CARD_CLASS, TOOL_CARD_WIDTH_CLASS)}>
        <div className="flex min-w-0 items-center gap-2.5">
          {pending
            ? <Loader2 className="size-3.5 shrink-0 animate-spin text-logo" />
            : <Icon className="size-4 shrink-0 text-muted-foreground" />}
          <span className={cn("min-w-0 truncate", !pending && "text-muted-foreground")}>{title}</span>
        </div>
        <p className={TOOL_CARD_CAPTION_CLASS}>{caption}</p>
      </div>
    )
  }

  const caption = [verb, formatScheduleTrigger(schedule.trigger), toMessagePreview(schedule.content)].filter(Boolean).join(" · ")
  return <ScheduleCardBox schedule={schedule} context={context} caption={caption} />
}

/**
 * A live schedule's card: the row, its hover card with the recent runs, and
 * Edit. A tool call's card is one use. The other is a message the schedule
 * sent, which names it with the same card as a quote (SourcedMessage).
 */
export function ScheduleCardBox({ schedule, context, caption, quote = false }: {
  schedule: ChatSchedule
  context: ChatSchedulesValue
  caption: string
  quote?: boolean
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const on = schedule.enabled && schedule.nextRunAt != null
  const now = useMinuteClock(on)
  const Icon = TRIGGER_ICON[schedule.trigger.kind]
  const classes = toolCardClasses(quote)
  const edit = () => context.onEdit(schedule)

  return (
    <div ref={containerRef} className={classes.width}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            // What the hover card finds the card under the pointer by.
            data-row-key={schedule.id}
            className={cn(
              classes.box,
              // Lit under the pointer and while its hover card is up, as a
              // chat's card is. It does not give under a press: there is
              // nothing a press does.
              classes.lit,
              "select-none",
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn("min-w-0 shrink truncate", !on && "text-muted-foreground")}>{schedule.name}</span>
              <span className="ml-auto shrink-0 pl-3 text-xs tabular-nums text-muted-foreground">{formatScheduleState(schedule, now)}</span>
            </div>
            <p className={TOOL_CARD_CAPTION_CLASS}>{caption}</p>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={edit}>
            <Pencil className="size-3.5" />
            <span>Edit Schedule…</span>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <ListHoverCard
        containerRef={containerRef}
        side="bottom"
        // Just clear of the card, as under a chat's.
        sideOffset={6}
      >
        {(_key, dismiss) => (
          <ScheduleCard
            schedule={schedule}
            now={now}
            currentChatId={context.chatId}
            onEdit={() => {
              dismiss()
              edit()
            }}
          />
        )}
      </ListHoverCard>
    </div>
  )
}
