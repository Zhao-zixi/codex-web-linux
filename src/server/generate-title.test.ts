import { describe, expect, test } from "bun:test"
import { attachDelegationBlock } from "../shared/delegation-block"
import { fallbackTitleFromMessage } from "./generate-title"

describe("fallbackTitleFromMessage", () => {
  test("titles a message by what the user wrote, not by what Kanna added for the agent", () => {
    expect(fallbackTitleFromMessage(attachDelegationBlock("Fix login"))).toBe("Fix login")
    expect(fallbackTitleFromMessage("<system-message>for the agent</system-message>\n\nShip it")).toBe("Ship it")
  })

  test("a message that is only for the agent has no title", () => {
    expect(fallbackTitleFromMessage(attachDelegationBlock(""))).toBeNull()
  })
})
