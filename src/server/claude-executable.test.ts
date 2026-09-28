import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import {
  claudeCodeMinimumVersion,
  requireClaudeExecutable,
  resolveClaudeExecutable,
} from "./claude-executable"

const found = (path: string | null) => () => path

describe("resolveClaudeExecutable", () => {
  test("runs the user's claude when it is new enough", async () => {
    const result = await resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/Users/me/.local/bin/claude"),
      readVersion: async () => "2.1.280",
      minimumVersion: "2.1.277",
    })
    expect(result).toEqual({ ok: true, path: "/Users/me/.local/bin/claude", version: "2.1.280" })
  })

  test("an older claude is outdated, with the update named", async () => {
    const result = await resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/opt/homebrew/bin/claude"),
      readVersion: async () => "2.1.200",
      minimumVersion: "2.1.277",
    })
    expect(result).toMatchObject({ ok: false, reason: "outdated", version: "2.1.200" })
    expect(!result.ok && result.message).toContain("claude update")
  })

  test("no claude on PATH is not installed; the SDK's own copy is never the fallback", async () => {
    const result = await resolveClaudeExecutable({ env: {}, resolveCommandPath: found(null) })
    expect(result).toMatchObject({ ok: false, reason: "not_installed" })
    await expect(requireClaudeExecutable({ env: {}, resolveCommandPath: found(null) })).rejects.toThrow("isn't installed")
  })

  test("CLAUDE_EXECUTABLE wins, ~ expanded, without a version check", async () => {
    let versionRead = false
    const result = await resolveClaudeExecutable({
      env: { CLAUDE_EXECUTABLE: "~/bin/claude-bedrock" },
      resolveCommandPath: found("/usr/local/bin/claude"),
      readVersion: async () => {
        versionRead = true
        return "1.0.0"
      },
    })
    expect(result).toEqual({ ok: true, path: `${homedir()}/bin/claude-bedrock`, version: null })
    expect(versionRead).toBe(false)
  })

  test("an unreadable version is let through", async () => {
    const result = await resolveClaudeExecutable({
      env: {},
      resolveCommandPath: found("/usr/local/bin/claude"),
      readVersion: async () => null,
      minimumVersion: "2.1.277",
    })
    expect(result).toMatchObject({ ok: true, version: null })
  })

  test("the floor is the Claude Code version the installed SDK pairs with", () => {
    expect(claudeCodeMinimumVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
