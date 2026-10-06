import { useEffect, useRef, useState } from "react"
import { CalendarClock, Clock, Pencil, Repeat, type LucideIcon } from "lucide-react"
import type { ChatSchedule, ScheduleRun, ScheduleTrigger } from "../../../../shared/types"
import { toMessagePreview } from "../../../../shared/message-preview"
import { cn } from "../../../lib/utils"
import { formatPromptTimestamp } from "../../messages/ResultMessage"
import { useChatReferenceActions, useSidebarThread } from "../chat-reference"
import { ContextMenuItem } from "../../ui/context-menu"
import { TURN_CARD_ROW_INSET, TurnCardMetaRow, TurnCardMetaSeparator } from "../../ui/turn-card"
import { WidgetList, WidgetRow } from "./parts"
import { WidgetCard } from "./WidgetCard"
import { WidgetHoverCard } from "./WidgetHoverCard"

/**
 * The schedules to do with this chat: the ones that send it a message, the
 * ones its agent set up to run elsewhere, and the one that started it.
 *
 * A row says what a schedule is and when it runs next. Its card says the
 * rest: the message, where it goes, and how its recent runs went.
 *
 * There is no form here. A schedule is set up by asking the agent, so it is
 * changed the same way: Edit starts that sentence in the composer and leaves
 * you to finish it. Nothing on a row acts on a click, since writing into the
 * composer is not something to do by accident.
 */

/** Runs a card lists, newest first. The schedule keeps more; these are the ones worth a glance. */
const CARD_RUNS = 5

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const TRIGGER_ICON: Record<ScheduleTrigger["kind"], LucideIcon> = {
  once: Clock,
  interval: Repeat,
  daily: CalendarClock,
}

/** "Every 5 min", "Daily at 09:00 · Mon, Wed", "Once". */
export function formatScheduleTrigger(trigger: ScheduleTrigger): string {
  if (trigger.kind === "once") return "Once"
  if (trigger.kind === "interval") {
    const minutes = Math.round(trigger.everyMs / 60_000)
    if (minutes % 1_440 === 0) return minutes === 1_440 ? "Every day" : `Every ${minutes / 1_440} days`
    if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`
    return `Every ${minutes} min`
  }
  const days = trigger.weekdays?.length && trigger.weekdays.length < 7
    ? ` · ${[...trigger.weekdays].sort((a, b) => a - b).map((day) => WEEKDAYS[day]).join(", ")}`
    : ""
  return `Daily at ${trigger.timeOfDay}${days}`
}

/** How long until a time, to the minute: "in 4m", "in 2h 10m", "in 3d". Due or overdue reads "now". */
export function formatUntil(at: number, now: number): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return "now"
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `in ${hours}h ${minutes % 60}m` : `in ${hours}h`
  return `in ${Math.floor(hours / 24)}d`
}

/**
 * Where a schedule stands, for the row's trailing slot: when it runs next,
 * or why it will not. A one-shot that ran, and a repeat that reached its
 * limit, are both simply done.
 */
export function formatScheduleState(schedule: ChatSchedule, now: number): string {
  if (schedule.enabled && schedule.nextRunAt != null) return formatUntil(schedule.nextRunAt, now)
  return schedule.nextRunAt == null ? "Done" : "Paused"
}

const RUN_OUTCOME: Record<ScheduleRun["outcome"], { label: string; className: string }> = {
  sent: { label: "Sent", className: "bg-emerald-500" },
  // Not a failure: the run before it was still going.
  skipped: { label: "Skipped", className: "bg-muted-foreground/40" },
  failed: { label: "Failed", className: "bg-destructive" },
}

/** The text Edit starts in the composer. The name is how the agent finds the schedule. */
export function scheduleEditPrompt(schedule: ChatSchedule): string {
  return `Update the schedule "${schedule.name}" to `
}

/** Re-renders on a slow tick while something is counting down. "in 4m" does not need a second hand. */
export function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 20_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function RunRow({ run, currentChatId }: { run: ScheduleRun; currentChatId: string | null }) {
  const actions = useChatReferenceActions()
  const outcome = RUN_OUTCOME[run.outcome]
  // A run into another chat names it and opens it. One into this chat has
  // nowhere to go: you are already here.
  const elsewhere = run.chatId && run.chatId !== currentChatId ? run.chatId : null
  const thread = useSidebarThread(elsewhere)
  const content = (
    <>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", outcome.className)} />
      <span className="shrink-0 text-popover-foreground">{outcome.label}</span>
      {thread ? <span className="min-w-0 truncate">{thread.title}</span> : null}
      <span className="ml-auto shrink-0 pl-2 tabular-nums">{formatPromptTimestamp(new Date(run.at).toISOString())}</span>
    </>
  )
  const className = cn("flex w-full min-w-0 items-center gap-1.5 rounded-md text-left text-[12px] text-muted-foreground", TURN_CARD_ROW_INSET)
  if (!thread || !actions) return <div className={className}>{content}</div>
  return (
    <button type="button" onClick={() => actions.onOpenChat(thread.chatId)} className={cn(className, "cursor-pointer hover:bg-muted")}>
      {content}
    </button>
  )
}

export function ScheduleCard({ schedule, now, currentChatId, onEdit }: {
  schedule: ChatSchedule
  now: number
  currentChatId: string | null
  onEdit: () => void
}) {
  const target = schedule.target
  const targetThread = useSidebarThread(target.kind === "chat" && target.chatId !== currentChatId ? target.chatId : null)
  const runs = [...(schedule.runs ?? [])].reverse().slice(0, CARD_RUNS)
  const destination = target.kind === "new_chat"
    ? "Starts a new chat each run"
    : target.chatId === currentChatId
      ? "Sends to this chat"
      : `Sends to ${targetThread?.title ?? "another chat"}`
  return (
    <>
      <TurnCardMetaRow>
        <span className="truncate">{formatScheduleTrigger(schedule.trigger)}</span>
        <TurnCardMetaSeparator />
        <span className="shrink-0">
          {schedule.enabled && schedule.nextRunAt != null
            ? `Next ${formatPromptTimestamp(new Date(schedule.nextRunAt).toISOString())}`
            : formatScheduleState(schedule, now)}
        </span>
      </TurnCardMetaRow>
      <div className={cn("mt-1 line-clamp-2 text-sm font-medium text-popover-foreground", TURN_CARD_ROW_INSET)}>{schedule.name}</div>
      <div className={cn("line-clamp-[6] whitespace-pre-wrap text-sm text-muted-foreground", TURN_CARD_ROW_INSET)}>{toMessagePreview(schedule.content)}</div>
      <TurnCardMetaRow className="mt-1">
        <span className="truncate">{destination}</span>
        {schedule.maxRuns ? (
          <>
            <TurnCardMetaSeparator />
            <span className="shrink-0">{schedule.runCount} of {schedule.maxRuns} runs</span>
          </>
        ) : null}
      </TurnCardMetaRow>
      {/* Edge to edge, as the chat card's rule is: the card pads by 6px. */}
      <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
      <div className="mt-1.5">
        {runs.length > 0
          ? runs.map((run) => <RunRow key={`${run.at}:${run.outcome}`} run={run} currentChatId={currentChatId} />)
          : <div className={cn("text-[12px] text-muted-foreground/70", TURN_CARD_ROW_INSET)}>No runs yet</div>}
      </div>
      <div className="-mx-1.5 mt-2 border-t border-border/60" aria-hidden />
      {/* The card's one action, full width so it is the same target every
          time. The press gives a little, like every button here. */}
      <button
        type="button"
        onClick={onEdit}
        className={cn(
          "mt-1.5 flex w-full cursor-pointer items-center gap-1.5 rounded-md text-left text-[12px] text-muted-foreground hover:bg-muted hover:text-popover-foreground",
          "transition-[scale] duration-150 ease-snappy active:scale-[0.98] motion-reduce:transition-none motion-reduce:active:scale-100",
          TURN_CARD_ROW_INSET,
        )}
      >
        <Pencil className="size-3 shrink-0" />
        <span>Edit by asking the agent</span>
      </button>
    </>
  )
}

export function SchedulesWidget({ schedules, chatId, onEdit }: {
  schedules: readonly ChatSchedule[]
  chatId: string | null
  /** Starts an edit of the schedule in the composer. */
  onEdit: (schedule: ChatSchedule) => void
}) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const active = schedules.filter((schedule) => schedule.enabled && schedule.nextRunAt != null).length
  const now = useMinuteClock(active > 0)
  return (
    <WidgetCard
      icon={<CalendarClock />}
      title="Schedules"
      count={active === schedules.length ? String(schedules.length) : `${active} of ${schedules.length} on`}
    >
      <WidgetList listRef={listRef}>
        {schedules.map((schedule) => {
          const Icon = TRIGGER_ICON[schedule.trigger.kind]
          const on = schedule.enabled && schedule.nextRunAt != null
          return (
            <WidgetRow
              key={schedule.id}
              rowKey={schedule.id}
              // A schedule that will not run again recedes; one that will stays at full strength.
              muted={!on}
              icon={<Icon />}
              title={schedule.name}
              subtitle={formatScheduleTrigger(schedule.trigger)}
              meta={formatScheduleState(schedule, now)}
              menuLabel="Schedule actions"
              menu={(
                <ContextMenuItem onSelect={() => onEdit(schedule)}>
                  <Pencil className="size-3.5" />
                  <span>Edit Schedule…</span>
                </ContextMenuItem>
              )}
            />
          )
        })}
      </WidgetList>
      <WidgetHoverCard containerRef={listRef}>
        {(scheduleId, dismiss) => {
          const schedule = schedules.find((candidate) => candidate.id === scheduleId)
          if (!schedule) return null
          return (
            <ScheduleCard
              schedule={schedule}
              now={now}
              currentChatId={chatId}
              // The card goes first: the composer is where the eye should land.
              onEdit={() => {
                dismiss()
                onEdit(schedule)
              }}
            />
          )
        }}
      </WidgetHoverCard>
    </WidgetCard>
  )
}
