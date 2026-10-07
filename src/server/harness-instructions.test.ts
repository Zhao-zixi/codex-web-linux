import { describe, expect, test } from "bun:test"
import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAgentTrailer } from "./attribution"
import { buildKannaSystemInstructions, buildKannaSystemMessage, KANNA_ORCHESTRATION_INSTRUCTIONS, KANNA_VISUALIZATION_INSTRUCTIONS } from "./harness-instructions"
import { KANNA_TOOL_DESCRIPTION_LIMIT, KANNA_TOOL_NAMES, kannaToolSpecs } from "./kanna-tools"
import { SHOW_VISUALIZATION_TOOL } from "./kanna-visualization-tool"
import { KANNA_VISUALIZATION_CONTRACT, KANNA_VISUALIZATION_SKILL_INSTRUCTIONS } from "./visualization-instructions"
import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"

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


test("visualization instructions reach tool-enabled harnesses and prefer native inline results", () => {
  const instructions = buildKannaSystemInstructions(AGENT_ID)
  expect(instructions).toContain(KANNA_VISUALIZATION_INSTRUCTIONS)
  expect(instructions).toContain("show_visualization")
  expect(instructions).toContain("show_chart tool is retired")
  expect(instructions).toContain("do not generate charts or diagrams as PNGs")
  expect(instructions).toContain(KANNA_VISUALIZATION_SKILL_INSTRUCTIONS)
  // The corner the prompt keeps clear is the expand button's own, with a margin.
  const { size, inset, clear } = VISUALIZATION_EXPAND_BUTTON
  expect(clear).toBeGreaterThan(size + inset)
  const description = SHOW_VISUALIZATION_TOOL.description
  // What a model needs before its first line is in both places, in the same
  // terms: the header and the corner, the two controls, the text size, the cap.
  for (const text of [instructions, description]) {
    expect(text).toContain(`Keep the top-right ${clear}px by ${clear}px clear`)
    expect(text).toContain("kanna-segmented")
    expect(text).toContain("kanna-tabs")
    expect(text).toContain("16px")
    expect(text).toContain(`up to ${VISUALIZATION_MAX_HEIGHT}px`)
    expect(text).toContain("iOS")
    // Stated in both, strictly: nothing a reader does may move the conversation.
    expect(text).toContain("must never change after")
    expect(text).toContain("tallest state")
  }
  expect(instructions).toContain("No interaction may grow or shrink it")
  expect(instructions).toContain('<section id="stage" style="height:40px">')
  // The rest is only in the session instructions, which no harness cuts short.
  expect(instructions).toContain(KANNA_VISUALIZATION_CONTRACT)
  expect(instructions).toContain(`${size}px expand button`)
  expect(instructions).toContain("window.kanna.download")
  expect(instructions).toContain("kanna:themechange")
  expect(instructions).toContain("touch-action: none")
  expect(instructions).toContain("UI prototypes")
  expect(instructions).toContain(`<header style="padding-right:${clear}px">`)
  expect(instructions).not.toContain("<select aria-label")
  // And the description says where, and opens with the contract, not with what to avoid.
  expect(description).toContain('under "Kanna visualizations"')
  expect(instructions).toContain("# Kanna visualizations")
  expect(description.startsWith("Render self-contained interactive HTML")).toBe(true)
  expect(description).not.toContain(KANNA_VISUALIZATION_SKILL_INSTRUCTIONS)
  expect(buildKannaSystemMessage(AGENT_ID)).toContain(KANNA_VISUALIZATION_INSTRUCTIONS)
  expect(buildKannaSystemInstructions(AGENT_ID, { tools: false })).not.toContain("show_visualization")
})

// Claude Code cuts an MCP tool's description at this length and ends it
// "[truncated]". An 8,000-character description reached Claude as its first
// quarter, and an agent went and read the rest out of the installed bundle.
test("no tool's description is longer than the shortest a harness keeps", () => {
  expect(KANNA_TOOL_DESCRIPTION_LIMIT).toBe(2048)
  for (const tool of kannaToolSpecs()) {
    expect(`${tool.name}: ${tool.description.length}`).toBe(`${tool.name}: ${Math.min(tool.description.length, KANNA_TOOL_DESCRIPTION_LIMIT)}`)
  }
})
