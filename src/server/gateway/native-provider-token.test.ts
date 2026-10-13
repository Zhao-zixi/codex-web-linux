import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createNativeProviderTokenController } from "./native-provider-token"

const directories: string[] = []

async function createHome() {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "kanna-native-provider-"))
  directories.push(homeDir)
  const claudeDir = path.join(homeDir, ".claude")
  await mkdir(claudeDir, { recursive: true })
  return { homeDir, claudeDir, env: { HOME: homeDir, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(homeDir, ".codex") } }
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("native provider token controller", () => {
  test("returns a fresh Claude OAuth access token without invoking login", async () => {
    const { homeDir, claudeDir, env } = await createHome()
    const now = Date.now()
    await writeFile(path.join(claudeDir, ".credentials.json"), JSON.stringify({
      claudeAiOauth: { accessToken: "test-access", refreshToken: "test-refresh", scopes: ["user:inference"], expiresAt: now + 300_000 },
    }))
    let refreshes = 0
    const controller = createNativeProviderTokenController({ homeDir, env, deps: {
      now: () => now,
      claudeRefresh: async () => { refreshes += 1 },
    } })
    await expect(controller.getToken("claude")).resolves.toEqual({ provider: "claude", accessToken: "test-access", expiresAt: now + 300_000 })
    expect(refreshes).toBe(0)
  })

  test("refreshes one expired Claude profile once for concurrent requests and returns no refresh credential", async () => {
    const { homeDir, claudeDir, env } = await createHome()
    const now = Date.now()
    const credentialPath = path.join(claudeDir, ".credentials.json")
    await writeFile(credentialPath, JSON.stringify({
      claudeAiOauth: { accessToken: "old-access", refreshToken: "test-refresh", scopes: ["user:inference", "user:profile"], expiresAt: now - 1 },
    }))
    let refreshes = 0
    let observedScopes = ""
    const controller = createNativeProviderTokenController({ homeDir, env, deps: {
      now: () => now,
      claudeRefresh: async ({ env: refreshEnv }) => {
        refreshes += 1
        observedScopes = refreshEnv.CLAUDE_CODE_OAUTH_SCOPES ?? ""
        await new Promise((resolve) => setTimeout(resolve, 10))
        await writeFile(credentialPath, JSON.stringify({
          claudeAiOauth: { accessToken: "new-access", refreshToken: "new-refresh", scopes: ["user:inference", "user:profile"], expiresAt: now + 600_000 },
        }))
      },
    } })
    const [first, second] = await Promise.all([controller.getToken("claude"), controller.getToken("claude")])
    expect(refreshes).toBe(1)
    expect(observedScopes).toBe("user:inference user:profile")
    expect(first).toEqual(second)
    expect(first).toEqual({ provider: "claude", accessToken: "new-access", expiresAt: now + 600_000 })
    expect(JSON.stringify(first)).not.toContain("refresh")
    expect(await readFile(credentialPath, "utf8")).toContain("new-refresh")
  })

  test("asks Codex app-server for the normal refreshed token and pins account identity", async () => {
    const { homeDir, env } = await createHome()
    let received: unknown
    const controller = createNativeProviderTokenController({ homeDir, env, deps: {
      now: () => Date.now(),
      codexToken: async (options) => {
        received = options
        return { accessToken: "codex-access", expiresAt: Date.now() + 60_000, chatgptAccountId: "account-1", chatgptPlanType: "plus" }
      },
    } })
    await expect(controller.getToken("codex", { forceRefresh: true, previousAccountId: "account-1" })).resolves.toMatchObject({
      provider: "codex", accessToken: "codex-access", chatgptAccountId: "account-1", chatgptPlanType: "plus",
    })
    expect(received).toEqual({ homeDir, forceRefresh: true, previousAccountId: "account-1" })
  })
})
