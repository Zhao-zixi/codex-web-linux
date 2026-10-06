import { describe, expect, test } from "bun:test"
import { attachDelegationBlock } from "../../../shared/delegation-block"
import { getPreviousPrompt, getUserPromptSignature } from "../kannaStateHelpers"
import { buildChatGraphLocationState, readChatGraphRequestedChatId } from "./openGraphChat"

describe("graph route state", () => {
  test("carries the chat that was asked for", () => {
    expect(readChatGraphRequestedChatId(buildChatGraphLocationState("leaf"))).toBe("leaf")
  })

  test("reads nothing from state that is not its own", () => {
    expect(readChatGraphRequestedChatId(null)).toBeNull()
    expect(readChatGraphRequestedChatId({ jumpToRole: "reply", jumpRequestId: "r1" })).toBeNull()
    expect(readChatGraphRequestedChatId({ graphRequestedChatId: "" })).toBeNull()
  })
})

describe("a message sent from the graph", () => {
  const sent = attachDelegationBlock("Fix the flaky login test")

  test("comes back to the composer as it was typed", () => {
    expect(getPreviousPrompt([
      { kind: "user_prompt", id: "p1", content: sent, timestamp: "2026-01-01T00:00:00.000Z" },
    ])).toBe("Fix the flaky login test")
  })

  test("is skipped by recall when nothing was typed", () => {
    expect(getPreviousPrompt([
      { kind: "user_prompt", id: "p1", content: "earlier", timestamp: "2026-01-01T00:00:00.000Z" },
      { kind: "user_prompt", id: "p2", content: attachDelegationBlock(""), timestamp: "2026-01-01T00:00:01.000Z" },
    ])).toBe("earlier")
  })

  test("is matched to its stored copy whole, block included", () => {
    // The optimistic prompt and the server's entry hold the same text, so the
    // one replaces the other as for any message.
    expect(getUserPromptSignature(sent, [])).toBe(getUserPromptSignature(attachDelegationBlock("Fix the flaky login test"), []))
    expect(getUserPromptSignature(sent, [])).not.toBe(getUserPromptSignature("Fix the flaky login test", []))
  })
})
