import { describe, expect, test } from "bun:test"
import type { ChatSchedule } from "../../../../shared/types"
import { formatScheduleState, formatScheduleTrigger, formatUntil, scheduleEditPrompt } from "./SchedulesWidget"

const MINUTE = 60_000

function schedule(overrides: Partial<ChatSchedule> = {}): ChatSchedule {
  return {
    id: "s",
    name: "Nightly triage",
    content: "triage new issues",
    target: { kind: "chat", chatId: "c" },
    trigger: { kind: "interval", everyMs: 5 * MINUTE },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: 10 * MINUTE,
    runCount: 0,
    ...overrides,
  }
}

describe("schedule labels", () => {
  test("a trigger reads as a person would say it", () => {
    expect(formatScheduleTrigger({ kind: "once", at: 0 })).toBe("Once")
    expect(formatScheduleTrigger({ kind: "interval", everyMs: 5 * MINUTE })).toBe("Every 5 min")
    expect(formatScheduleTrigger({ kind: "interval", everyMs: 60 * MINUTE })).toBe("Every hour")
    expect(formatScheduleTrigger({ kind: "interval", everyMs: 180 * MINUTE })).toBe("Every 3 hours")
    expect(formatScheduleTrigger({ kind: "interval", everyMs: 1_440 * MINUTE })).toBe("Every day")
    expect(formatScheduleTrigger({ kind: "daily", timeOfDay: "09:00" })).toBe("Daily at 09:00")
    expect(formatScheduleTrigger({ kind: "daily", timeOfDay: "09:00", weekdays: [3, 1] })).toBe("Daily at 09:00 · Mon, Wed")
    // Every day listed is no restriction, so it is not spelled out.
    expect(formatScheduleTrigger({ kind: "daily", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Daily at 09:00")
  })

  test("time until a run is to the minute, and never negative", () => {
    expect(formatUntil(30_000, 0)).toBe("in 1m")
    expect(formatUntil(4 * MINUTE, 0)).toBe("in 4m")
    expect(formatUntil(130 * MINUTE, 0)).toBe("in 2h 10m")
    expect(formatUntil(120 * MINUTE, 0)).toBe("in 2h")
    expect(formatUntil(3 * 1_440 * MINUTE, 0)).toBe("in 3d")
    expect(formatUntil(0, 5 * MINUTE)).toBe("now")
  })

  test("a row says when it runs next, or why it will not", () => {
    expect(formatScheduleState(schedule(), 6 * MINUTE)).toBe("in 4m")
    expect(formatScheduleState(schedule({ enabled: false }), 0)).toBe("Paused")
    // A one-shot that fired, or a repeat that reached its limit.
    expect(formatScheduleState(schedule({ enabled: false, nextRunAt: null }), 0)).toBe("Done")
  })

  test("Edit starts a sentence that names the schedule and leaves the rest to type", () => {
    expect(scheduleEditPrompt(schedule())).toBe('Update the schedule "Nightly triage" to ')
  })
})
