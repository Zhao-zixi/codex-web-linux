import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatSchedule } from "../../../shared/types"
import { ChatSchedulesProvider } from "../chat-ui/chat-reference"
import { ScheduleToolMessage } from "./ScheduleToolMessage"
import type { ProcessedToolCall } from "./types"

function schedule(overrides: Partial<ChatSchedule> = {}): ChatSchedule {
  return {
    id: "s1",
    name: "Deploy check",
    content: "check the deploy",
    target: { kind: "chat", chatId: "c" },
    trigger: { kind: "interval", everyMs: 5 * 60_000 },
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    nextRunAt: Date.now() + 4 * 60_000 - 1_000,
    runCount: 0,
    ...overrides,
  }
}

function call(toolName: string, payload: Record<string, unknown>, rawResult: unknown): Extract<ProcessedToolCall, { toolKind: "schedule" }> {
  return { id: "m", kind: "tool", toolKind: "schedule", toolName, toolId: "t", input: { payload }, rawResult, resultEntryId: "r", timestamp: new Date().toISOString() }
}

function render(message: Extract<ProcessedToolCall, { toolKind: "schedule" }>, schedules: ChatSchedule[]) {
  return renderToStaticMarkup(
    <ChatSchedulesProvider value={{ chatId: "c", schedules, onEdit: () => {} }}>
      <ScheduleToolMessage message={message} />
    </ChatSchedulesProvider>,
  )
}

describe("ScheduleToolMessage", () => {
  // The card is the schedule as it stands, not a record of the call: what it
  // is called now, when it runs next now.
  test("shows the schedule as it is now, not as the call left it", () => {
    const message = call("set_schedule", { name: "Old name", message: "old text", everyMinutes: 60 }, { scheduleId: "s1", name: "Old name" })
    const html = render(message, [schedule()])
    expect(html).toContain("Deploy check")
    expect(html).toContain("in 4m")
    expect(html).toContain("Scheduled · Every 5 min · check the deploy")
    expect(html).not.toContain("Old name")
  })

  test("says when a schedule is paused or has finished", () => {
    const message = call("set_schedule", { scheduleId: "s1", enabled: false }, { scheduleId: "s1" })
    expect(render(message, [schedule({ enabled: false })])).toContain("Paused")
    expect(render(message, [schedule({ enabled: false, nextRunAt: null })])).toContain("Done")
    expect(render(message, [schedule({ enabled: false })])).toContain("Updated ·")
  })

  // Deleted since, or another chat's: the card still says what the call did.
  test("falls back to what the call said when the schedule is not at hand", () => {
    const html = render(call("set_schedule", { name: "Nightly", message: "triage", dailyAt: "02:00" }, { scheduleId: "gone", name: "Nightly", message: "triage" }), [])
    expect(html).toContain("Nightly")
    expect(html).toContain("Scheduled · Daily at 02:00 · triage")
  })

  test("a deleted schedule is named and marked deleted, never shown as live", () => {
    const html = render(call("delete_schedule", { scheduleId: "s1" }, { deleted: "s1", name: "Deploy check" }), [schedule()])
    expect(html).toContain("Deploy check")
    expect(html).toContain("Deleted")
    expect(html).not.toContain("in 4m")
  })

  test("a failed call shows its error", () => {
    const failed = { ...call("set_schedule", { message: "x" }, [{ type: "text", text: "Say when it runs: inMinutes, runAt, everyMinutes or dailyAt." }]), isError: true }
    expect(render(failed, [])).toContain("Say when it runs")
  })
})
