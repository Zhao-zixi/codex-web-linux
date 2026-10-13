import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

  test("real Codex helper refreshes once then reads account metadata without rotating the token", async () => {
    const { homeDir, env } = await createHome()
    const binDir = path.join(homeDir, ".local", "bin")
    await mkdir(binDir, { recursive: true })
    const callsPath = path.join(homeDir, "rpc-calls.jsonl")
    const now = Date.now()
    const jwt = (expiresAt: number) => `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(expiresAt / 1000) })).toString("base64url")}.sig`
    const oldToken = jwt(now + 5_000)
    const refreshedToken = jwt(now + 600_000)
    const script = `#!/usr/bin/env node
const readline = require("node:readline")
const fs = require("node:fs")
const oldToken = ${JSON.stringify(oldToken)}
const refreshedToken = ${JSON.stringify(refreshedToken)}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line)
  if (typeof request.id !== "number") return
  fs.appendFileSync(process.env.FAKE_CODEX_CALL_LOG, JSON.stringify(request) + "\\n")
  let result = {}
  if (request.method === "getAuthStatus") result = { authMethod: "chatgpt", authToken: request.params.refreshToken ? refreshedToken : oldToken }
  if (request.method === "account/read") result = { account: { planType: "plus" }, workspaceRouting: { chatgptAccountId: "acct-1" } }
  process.stdout.write(JSON.stringify({ id: request.id, result }) + "\\n")
})
`
    await writeFile(path.join(binDir, "codex"), script, { mode: 0o700 })
    await chmod(path.join(binDir, "codex"), 0o700)
    const oldPath = process.env.PATH
    process.env.PATH = `${binDir}:${oldPath ?? ""}`
    try {
      const controller = createNativeProviderTokenController({
        homeDir,
        env: { ...env, FAKE_CODEX_CALL_LOG: callsPath },
        deps: { now: () => now },
      })
      await expect(controller.getToken("codex", { previousAccountId: "acct-1" })).resolves.toEqual({
        provider: "codex", accessToken: refreshedToken, expiresAt: Math.floor((now + 600_000) / 1000) * 1000,
        chatgptAccountId: "acct-1", chatgptPlanType: "plus",
      })
      const calls = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
      expect(calls.filter((call) => call.method === "getAuthStatus").map((call) => call.params?.refreshToken)).toEqual([false, true])
      expect(calls.find((call) => call.method === "account/read")?.params?.refreshToken).toBe(false)
      expect(JSON.stringify(calls)).not.toContain(refreshedToken)
      await controller.getToken("codex", { forceRefresh: true, previousAccountId: "acct-1" })
      const callsAfterForce = (await readFile(callsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> })
      expect(callsAfterForce.filter((call) => call.method === "getAuthStatus").map((call) => call.params?.refreshToken)).toEqual([false, true, true])
    } finally {
      process.env.PATH = oldPath
    }
  })

  test("Codex RPC errors and premature child exit reject pending requests", async () => {
    const { homeDir, env } = await createHome()
    const binDir = path.join(homeDir, ".local", "bin")
    await mkdir(binDir, { recursive: true })
    const binary = path.join(binDir, "codex")
    const oldPath = process.env.PATH
    process.env.PATH = `${binDir}:${oldPath ?? ""}`
    try {
      await writeFile(binary, "#!/usr/bin/env node\nprocess.stdin.once('data', () => { process.stdout.write(JSON.stringify({ id: 1, error: { code: -32000 } }) + '\\n') })\n", { mode: 0o700 })
      await chmod(binary, 0o700)
      const rpcErrorController = createNativeProviderTokenController({ homeDir, env, deps: { cliTimeoutMs: 200 } })
      await expect(rpcErrorController.getToken("codex")).rejects.toThrow("Native Codex sign-in required")
      await writeFile(binary, "#!/usr/bin/env node\nprocess.stdin.once('data', () => process.exit(9))\n", { mode: 0o700 })
      const earlyExitController = createNativeProviderTokenController({ homeDir, env, deps: { cliTimeoutMs: 200 } })
      await expect(earlyExitController.getToken("codex")).rejects.toThrow("Native Codex sign-in required")
    } finally {
      process.env.PATH = oldPath
    }
  })
})
