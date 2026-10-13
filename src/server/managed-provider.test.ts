import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hasOwnProviderCredentials } from "./managed-provider"

const temporaryDirectories: string[] = []

async function createWorkspace() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "kanna-managed-provider-"))
  const projectDir = path.join(homeDir, "project")
  temporaryDirectories.push(homeDir)
  await mkdir(projectDir)
  return { homeDir, projectDir }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("hasOwnProviderCredentials", () => {
  test("respects project Claude settings.json as user-owned provider configuration", async () => {
    const { homeDir, projectDir } = await createWorkspace()
    const claudeDir = path.join(projectDir, ".claude")
    await mkdir(claudeDir)
    await writeFile(path.join(claudeDir, "settings.json"), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: "https://example.invalid" },
    }))

    expect(await hasOwnProviderCredentials("claude", { homeDir, projectDir, env: {} })).toBe(true)
  })

  test("fails closed for malformed project Claude settings.local.json", async () => {
    const { homeDir, projectDir } = await createWorkspace()
    const claudeDir = path.join(projectDir, ".claude")
    await mkdir(claudeDir)
    await writeFile(path.join(claudeDir, "settings.local.json"), "{ malformed")

    expect(await hasOwnProviderCredentials("claude", { homeDir, projectDir, env: {} })).toBe(true)
  })
})
