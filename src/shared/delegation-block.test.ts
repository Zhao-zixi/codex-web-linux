import { describe, expect, test } from "bun:test"
import { attachDelegationBlock, DELEGATION_BLOCK, DELEGATION_INSTRUCTIONS } from "./delegation-block"
import { stripSystemMessages, toMessagePreview } from "./message-preview"
import { buildTranscriptOutline } from "./transcript-window"

describe("attachDelegationBlock", () => {
  test("puts the block after what was typed, in system-message tags", () => {
    const sent = attachDelegationBlock("Fix the flaky login test")
    expect(sent.startsWith("Fix the flaky login test\n\n<system-message>\n")).toBe(true)
    expect(sent.endsWith("\n</system-message>")).toBe(true)
    expect(sent).toContain(DELEGATION_INSTRUCTIONS)
  })

  test("keeps a slash invocation at the very start", () => {
    expect(attachDelegationBlock("/review the diff").startsWith("/review the diff")).toBe(true)
  })

  test("a message with only attachments is the block alone", () => {
    expect(attachDelegationBlock("   ")).toBe(DELEGATION_BLOCK)
  })

  test("does not attach twice", () => {
    const once = attachDelegationBlock("Ship it")
    expect(attachDelegationBlock(once)).toBe(once)
  })

  test("everything that shows a message shows only what was typed", () => {
    const sent = attachDelegationBlock("Fix the flaky login test")
    expect(stripSystemMessages(sent)).toBe("Fix the flaky login test")
    expect(toMessagePreview(sent)).toBe("Fix the flaky login test")
    expect(buildTranscriptOutline([{ _id: "p1", kind: "user_prompt", content: sent, createdAt: 1 }])[0]?.preview)
      .toBe("Fix the flaky login test")
    expect(stripSystemMessages(attachDelegationBlock(""))).toBe("")
  })

  test("says what the user asked it to say", () => {
    expect(DELEGATION_INSTRUCTIONS).toStartWith("The user is working in a task delegation environment. Do not work on this directly.")
    expect(DELEGATION_INSTRUCTIONS).toContain("- decide if the message you send should steer or enqueue")
    expect(DELEGATION_INSTRUCTIONS).toEndWith("use the Kanna mcp to do all these things, and act accordingly")
  })

  test("tells the agent to adopt an existing thread it hands the task to", () => {
    const lines = DELEGATION_INSTRUCTIONS.split("\n")
    const existingThread = lines.indexOf("- decide if the task should be sent to an existing thread")
    // Under the bullet it qualifies, named the way the tool takes it.
    expect(lines[existingThread + 1]).toStartWith("  - if you send it to an existing thread, adopt it")
    expect(lines[existingThread + 1]).toContain("adopt: true on send_message")
    expect(lines[existingThread + 1]).toContain("reports back to you")
    expect(lines[existingThread + 2]).toBe("- decide if the message you send should steer or enqueue")
  })
})
