import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hasOwnProviderCredentials, resolveManagedProvider } from "./managed-provider"

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

describe("resolveManagedProvider", () => {
  test("prefers assigned native auth over API keys and refreshes through the token broker", async () => {
    const { homeDir, projectDir } = await createWorkspace()
    const requests: Array<{ url: string; body?: any }> = []
    const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      requests.push({ url, body })
      if (url.endsWith("/internal/provider-access")) return Response.json({ selfFirst: true, assigned: [
        { id: "b".repeat(32), name: "API", provider: "codex", kind: "api_key", baseUrl: "http://gateway:3210/internal/providers/api/v1" },
        { id: "a".repeat(32), name: "Official", provider: "codex", kind: "native" },
      ] })
      return Response.json({ connectionId: "a".repeat(32), provider: "codex", expiresAt: 2000, accessToken: body?.forceRefresh ? "fresh" : "initial", chatgptAccountId: "acct-1" })
    }) as unknown as typeof fetch
    const result = await resolveManagedProvider("codex", { homeDir, projectDir, gatewayUrl: "http://gateway:3210", accountToken: "service-token", env: {}, fetchFn })
    expect(result?.kind).toBe("native")
    expect(result?.accessToken).toBe("initial")
    expect(await result?.getToken?.(true)).toMatchObject({ accessToken: "fresh", chatgptAccountId: "acct-1" })
    expect(requests[1]?.url).toEndWith(`/internal/providers/${"a".repeat(32)}/native-token`)
    expect(requests[2]?.body).toEqual({ forceRefresh: true, previousAccountId: "acct-1" })
  })

  test("does not fall back to an assigned API key when native token acquisition fails", async () => {
    const { homeDir, projectDir } = await createWorkspace()
    const requested: string[] = []
    const fetchFn = (async (input: URL | RequestInfo) => {
      const url = String(input)
      requested.push(url)
      if (url.endsWith("/internal/provider-access")) return Response.json({ selfFirst: true, assigned: [
        { id: "a".repeat(32), name: "Official", provider: "claude", kind: "native" },
        { id: "b".repeat(32), name: "API", provider: "claude", kind: "api_key", baseUrl: "http://gateway:3210/internal/providers/api" },
      ] })
      return new Response("failed", { status: 503 })
    }) as unknown as typeof fetch
    await expect(resolveManagedProvider("claude", { homeDir, projectDir, gatewayUrl: "http://gateway:3210", accountToken: "service-token", env: {}, fetchFn })).rejects.toThrow("Managed provider token is unavailable")
    expect(requested).toHaveLength(2)
    expect(requested[1]).toContain(`/internal/providers/${"a".repeat(32)}/native-token`)
  })
})
