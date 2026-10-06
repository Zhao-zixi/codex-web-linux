import { describe, expect, test } from "bun:test"
import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAgentTrailer } from "./attribution"
import { buildKannaSystemInstructions, buildKannaSystemMessage, KANNA_ORCHESTRATION_INSTRUCTIONS } from "./harness-instructions"
import { KANNA_TOOL_NAMES } from "./kanna-tools"

const AGENT_ID = "claude/claude-opus-5"

describe("buildKannaSystemInstructions", () => {
  test("carries the attribution and the chat-link rules", () => {
    const instructions = buildKannaSystemInstructions(AGENT_ID)
    expect(instructions).toContain(buildKannaAgentTrailer(AGENT_ID))
    expect(instructions).toContain(KANNA_CHAT_LINK_INSTRUCTIONS)
  })

  test("explains the chat tools only to a harness that has them", () => {
    expect(buildKannaSystemInstructions(AGENT_ID)).toContain(KANNA_ORCHESTRATION_INSTRUCTIONS)
    expect(buildKannaSystemInstructions(AGENT_ID, { tools: false })).not.toContain("create_chat")
    expect(buildKannaSystemMessage(AGENT_ID, { tools: false })).not.toContain("create_chat")
  })

  test("names only tools that exist", () => {
    const named = [...KANNA_ORCHESTRATION_INSTRUCTIONS.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]!)
    expect(named.length).toBeGreaterThan(0)
    for (const name of named) {
      if (name === "kanna" || name.startsWith("mcp__")) continue
      expect(KANNA_TOOL_NAMES).toContain(name)
    }
  })
})

describe("buildKannaSystemMessage", () => {
  test("wraps the instructions for the no-append-hook providers", () => {
    const message = buildKannaSystemMessage(AGENT_ID)
    expect(message.startsWith("<system-message>")).toBe(true)
    expect(message.endsWith("</system-message>")).toBe(true)
    expect(message).toContain(buildKannaSystemInstructions(AGENT_ID))
  })
})
