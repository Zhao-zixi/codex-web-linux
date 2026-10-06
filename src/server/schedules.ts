import type { ChatSchedule, ScheduleRun, ScheduleTrigger } from "../shared/types"

/** A schedule fires no more often than this. An agent's typo should not start a chat every second. */
export const MIN_SCHEDULE_INTERVAL_MS = 60_000

/**
 * The longest a single timer is armed for. `setTimeout` overflows past about
 * 24.8 days and fires at once, and a machine that slept wakes with its timers
 * late, so the runner re-reads the clock at least this often.
 */
const MAX_TIMER_MS = 60 * 60 * 1_000

/** How many past runs a schedule remembers. */
export const MAX_RECORDED_RUNS = 20

export function parseTimeOfDay(timeOfDay: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeOfDay.trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return { hours, minutes }
}

/** When `trigger` fires next, strictly after `after`. Null when it never will again. */
export function computeNextRun(trigger: ScheduleTrigger, after: number): number | null {
  if (trigger.kind === "once") return trigger.at > after ? trigger.at : null
  if (trigger.kind === "interval") return after + Math.max(MIN_SCHEDULE_INTERVAL_MS, trigger.everyMs)

  const time = parseTimeOfDay(trigger.timeOfDay)
  if (!time) return null
  const weekdays = trigger.weekdays?.length ? new Set(trigger.weekdays) : null
  const candidate = new Date(after)
  // Eight days covers "the same weekday, next week" when today's slot has passed.
  for (let day = 0; day < 8; day += 1) {
    // Set on every step, not once: a daylight-saving change moves the wall
    // clock, and the schedule follows the wall clock.
    candidate.setHours(time.hours, time.minutes, 0, 0)
    if (candidate.getTime() > after && (!weekdays || weekdays.has(candidate.getDay()))) {
      return candidate.getTime()
    }
    candidate.setDate(candidate.getDate() + 1)
  }
  return null
}

/**
 * The first run of a new schedule. A one-shot keeps its own time even when
 * that has passed, so "at 9:00" set at 9:00:02 still runs.
 */
export function computeFirstRun(trigger: ScheduleTrigger, now: number): number | null {
  return trigger.kind === "once" ? trigger.at : computeNextRun(trigger, now)
}

/** `sent` names the chat the message went to. `skipped` and `gone` send nothing. */
export type ScheduleFireResult =
  | { outcome: "sent"; chatId: string }
  /** The previous run is still going. */
  | { outcome: "skipped" }
  /** The chat or project it targets no longer exists. */
  | { outcome: "gone" }

interface ScheduleRunnerDeps {
  store: {
    listSchedules: () => ChatSchedule[]
    getSchedule: (scheduleId: string) => ChatSchedule | null
    setSchedule: (schedule: ChatSchedule) => Promise<ChatSchedule>
  }
  fire: (schedule: ChatSchedule) => Promise<ScheduleFireResult>
  onFired?: (schedule: ChatSchedule, result: ScheduleFireResult) => void
  onError?: (schedule: ChatSchedule, error: unknown) => void
  now?: () => number
}

/**
 * Fires due schedules off one timer, armed for the earliest of them.
 *
 * The next run is always computed from the time of firing, never from the
 * time it was due. A machine that was off or asleep for a week runs each
 * schedule once when it comes back, not once per missed slot.
 */
export class ScheduleRunner {
  private timer: ReturnType<typeof setTimeout> | null = null
  private ticking = false
  private disposed = false

  constructor(private readonly deps: ScheduleRunnerDeps) {}

  start() {
    this.arm()
  }

  /** Call after a schedule is created, changed or deleted. */
  refresh() {
    // A pass in progress arms the timer itself when it ends.
    if (!this.ticking) this.arm()
  }

  dispose() {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private now() {
    return this.deps.now?.() ?? Date.now()
  }

  private arm() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.disposed) return
    let earliest: number | null = null
    for (const schedule of this.deps.store.listSchedules()) {
      if (!schedule.enabled || schedule.nextRunAt == null) continue
      if (earliest == null || schedule.nextRunAt < earliest) earliest = schedule.nextRunAt
    }
    if (earliest == null) return
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, earliest - this.now()))
    this.timer = setTimeout(() => { void this.tick() }, delay)
  }

  /** Fires everything due now. Exposed so tests need no real timers. */
  async tick() {
    if (this.ticking || this.disposed) return
    this.ticking = true
    try {
      const now = this.now()
      const due = this.deps.store.listSchedules()
        .filter((schedule) => schedule.enabled && schedule.nextRunAt != null && schedule.nextRunAt <= now)
      for (const listed of due) {
        // Read again: an earlier schedule in this pass may have run long
        // enough for this one to be changed or deleted.
        const schedule = this.deps.store.getSchedule(listed.id)
        if (!schedule?.enabled || schedule.nextRunAt == null || schedule.nextRunAt > now) continue

        let result: ScheduleFireResult = { outcome: "skipped" }
        let failed = false
        try {
          result = await this.deps.fire(schedule)
        } catch (error) {
          failed = true
          this.deps.onError?.(schedule, error)
        }
        // A skipped run does not count against `maxRuns`: nothing was sent.
        const runCount = schedule.runCount + (result.outcome === "sent" ? 1 : 0)
        const exhausted = schedule.maxRuns != null && runCount >= schedule.maxRuns
        const nextRunAt = result.outcome === "gone" || exhausted ? null : computeNextRun(schedule.trigger, now)
        const current = this.deps.store.getSchedule(schedule.id)
        if (!current) continue
        await this.deps.store.setSchedule({
          ...current,
          runCount,
          nextRunAt,
          // Nothing left to run reads as off, so a list shows it as finished.
          enabled: nextRunAt != null,
          ...(result.outcome === "sent" ? { lastRunAt: now, lastRunChatId: result.chatId } : {}),
          // A target that is gone ends the schedule; it is not a run.
          ...(result.outcome === "gone" ? {} : {
            runs: [...(current.runs ?? []), {
              at: now,
              outcome: failed ? "failed" : result.outcome,
              ...(result.outcome === "sent" ? { chatId: result.chatId } : {}),
            } satisfies ScheduleRun].slice(-MAX_RECORDED_RUNS),
          }),
        })
        this.deps.onFired?.(schedule, result)
      }
    } finally {
      this.ticking = false
      this.arm()
    }
  }
}
