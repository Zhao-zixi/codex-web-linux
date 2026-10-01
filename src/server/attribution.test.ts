import { describe, expect, test } from "bun:test"
import {
  KANNA_AGENT_TRAILER_KEY,
  KANNA_COMMIT_FOOTER,
  KANNA_COMMIT_TRAILER,
  appendKannaAttribution,
  buildKannaAgentCorrection,
  buildKannaAgentId,
  buildKannaAgentTrailer,
  buildKannaAttributionInstructions,
  buildKannaCommitAttribution,
  buildKannaPrFooter,
  hasKannaFooter,
  hasKannaTrailer,
} from "./attribution"

const AGENT_ID = buildKannaAgentId("claude", "claude-opus-5")

describe("hasKannaTrailer", () => {
  test("detects the trailer on its own line", () => {
    expect(hasKannaTrailer(`fix: thing\n\n${KANNA_COMMIT_TRAILER}`)).toBe(true)
  })

  test("is case-insensitive on the trailer token", () => {
    expect(hasKannaTrailer("fix: thing\n\nco-authored-by: Kanna <noreply@kanna.sh>")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasKannaTrailer("document the Co-Authored-By: Kanna <noreply@kanna.sh> trailer")).toBe(false)
  })

  test("does not match another tool's trailer", () => {
    expect(hasKannaTrailer("fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>")).toBe(false)
  })
})

describe("hasKannaFooter", () => {
  test("detects the footer line", () => {
    expect(hasKannaFooter(`fix: thing\n\n${KANNA_COMMIT_FOOTER}`)).toBe(true)
  })

  test("detects it without the emoji", () => {
    expect(hasKannaFooter("fix: thing\n\nShipped with Kanna — https://kanna.sh")).toBe(true)
  })

  test("ignores a mention inside prose", () => {
    expect(hasKannaFooter("this release was shipped with Kanna and other tools")).toBe(false)
  })
})

describe("buildKannaCommitAttribution", () => {
  test("returns both parts for a bare message", () => {
    expect(buildKannaCommitAttribution("fix: thing")).toBe(`${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)
  })

  test("returns only the missing part", () => {
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_FOOTER}`)).toBe(KANNA_COMMIT_TRAILER)
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_TRAILER}`)).toBe(KANNA_COMMIT_FOOTER)
  })

  test("returns null when fully attributed", () => {
    expect(buildKannaCommitAttribution(`fix\n\n${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)).toBeNull()
  })
})

describe("appendKannaAttribution", () => {
  test("appends footer then trailer, trailer last", () => {
    expect(appendKannaAttribution("fix: thing")).toBe(
      `fix: thing\n\n${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`
    )
  })

  test("is idempotent", () => {
    const once = appendKannaAttribution("fix: thing")
    expect(appendKannaAttribution(once)).toBe(once)
  })

  test("handles an empty message", () => {
    expect(appendKannaAttribution("   ")).toBe(`${KANNA_COMMIT_FOOTER}\n\n${KANNA_COMMIT_TRAILER}`)
  })
})

describe("buildKannaAgentId", () => {
  test("joins provider and model", () => {
    expect(buildKannaAgentId("claude", "claude-opus-5")).toBe("claude/claude-opus-5")
  })

  test("leaves the harness recoverable when the model id contains a slash", () => {
    const id = buildKannaAgentId("opencode", "anthropic/claude-opus-5")
    expect(id.slice(0, id.indexOf("/"))).toBe("opencode")
  })
})

describe("buildKannaAttributionInstructions", () => {
  const instructions = buildKannaAttributionInstructions(AGENT_ID)

  test("carries every attribution surface verbatim", () => {
    expect(instructions).toContain(KANNA_COMMIT_TRAILER)
    expect(instructions).toContain(KANNA_COMMIT_FOOTER)
    expect(instructions).toContain(buildKannaAgentTrailer(AGENT_ID))
    expect(instructions).toContain(buildKannaPrFooter(AGENT_ID))
  })

  test("keeps the commit link bare and the PR link markdown", () => {
    expect(KANNA_COMMIT_FOOTER).not.toContain("](")
    expect(buildKannaPrFooter(AGENT_ID)).toContain("](https://kanna.sh)")
  })

  test("keeps the pitch out of the commit footer", () => {
    // Commit messages are permanent and squash-merges repeat them per commit,
    // so the tagline belongs to the PR body alone.
    expect(KANNA_COMMIT_FOOTER).not.toContain("open-source workspace")
    expect(buildKannaPrFooter(AGENT_ID)).toContain("open-source workspace")
  })

  test("puts the two trailers last, as one adjacent block", () => {
    const lines = instructions.split("\n")
    const trailerIndex = lines.indexOf(KANNA_COMMIT_TRAILER)
    expect(trailerIndex).toBeGreaterThan(-1)
    // Adjacent, not blank-separated: git only parses a trailing paragraph in
    // which every line is `key: value`.
    expect(lines[trailerIndex + 1]).toBe(buildKannaAgentTrailer(AGENT_ID))
  })

  test("the footer it dictates still satisfies the dedupe matchers", () => {
    const commit = [
      "fix: thing",
      "",
      KANNA_COMMIT_FOOTER,
      "",
      KANNA_COMMIT_TRAILER,
      buildKannaAgentTrailer(AGENT_ID),
    ].join("\n")
    expect(hasKannaFooter(commit)).toBe(true)
    expect(hasKannaTrailer(commit)).toBe(true)
    expect(buildKannaCommitAttribution(commit)).toBeNull()
  })
})

describe("buildKannaAgentCorrection", () => {
  test("carries the new id and names the trailer", () => {
    const correction = buildKannaAgentCorrection("claude/claude-sonnet-5")
    expect(correction).toContain("claude/claude-sonnet-5")
    expect(correction).toContain(KANNA_AGENT_TRAILER_KEY)
  })

  test("stays far shorter than the full instructions", () => {
    // It rides every turn after a mid-session model swap, so it must be the
    // value alone — the rule is already in the (cached) system prompt.
    expect(buildKannaAgentCorrection(AGENT_ID).length).toBeLessThan(
      buildKannaAttributionInstructions(AGENT_ID).length / 3
    )
  })
})
