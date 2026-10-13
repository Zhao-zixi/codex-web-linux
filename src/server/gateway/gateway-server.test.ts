import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fixedUpstreamUrl } from "./gateway-server"
import { startGatewayServer } from "./gateway-server"

describe("gateway fixed upstream URL", () => {
  test("keeps authority fixed even when a browser path begins with slashes", () => {
    const target = fixedUpstreamUrl("http://kanna_elim:3210", "//attacker.invalid/path", "?q=1")
    expect(target.origin).toBe("http://kanna_elim:3210")
    expect(target.pathname).toBe("//attacker.invalid/path")
    expect(target.search).toBe("?q=1")
  })

  test("keeps provider requests on the fixed official host", () => {
    const target = fixedUpstreamUrl("https://api.openai.com", "/v1/responses")
    expect(target.origin).toBe("https://api.openai.com")
    expect(target.pathname).toBe("/v1/responses")
  })

  test("requires the configured internal origin and account token; denies account users admin routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-gateway-http-"))
    const probe = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = probe.port
    probe.stop(true)
    const publicOrigin = `http://127.0.0.1:${port}`
    const tokenPath = path.join(root, "account-token")
    const passwordPath = path.join(root, "app-password")
    await writeFile(tokenPath, "test-account-capability-value-123456", { mode: 0o600 })
    await writeFile(passwordPath, "unused-workspace-password", { mode: 0o600 })
    await mkdir(path.join(root, "client"), { recursive: true })
    await writeFile(path.join(root, "client", "index.html"), "gateway")
    const gateway = await startGatewayServer({
      publicOrigin,
      internalOrigin: publicOrigin,
      accounts: [{ id: "elim", appUrl: "http://kanna_elim:3210", appPasswordFile: passwordPath, accountTokenFile: tokenPath }],
      stateDirectory: path.join(root, "state"),
      adminHomeDirectory: path.join(root, "admin-home"),
      clientDirectory: path.join(root, "client"),
      host: "127.0.0.1",
      port,
      providerControl: {
        getStatuses: async () => [],
        start: async () => undefined,
        submit: async () => undefined,
        cancel: async () => undefined,
        logout: async () => undefined,
        install: async () => undefined,
      },
      providerFetch: async () => Response.json({ error: "invalid credential test-provider-key" }, { status: 401 }),
    })
    try {
      const user = await gateway.store.createUser({ username: "elim", password: "test-user-password-123", role: "user", accountId: "elim" })
      const session = await gateway.store.createSession(user.id, 60_000)
      const admin = await gateway.store.createUser({ username: "admin", password: "test-admin-password-123", role: "admin" })
      const adminSession = await gateway.store.createSession(admin.id, 60_000)
      const connection = await gateway.store.createConnection({ name: "test", provider: "codex", apiKey: "test-provider-key" })
      await gateway.store.setUserConnections(user.id, [connection.id])
      const internal = await fetch(`${publicOrigin}/internal/provider-access`, {
        headers: { Authorization: "Bearer test-account-capability-value-123456" },
      })
      expect(internal.status).toBe(200)
      expect(await internal.json()).toMatchObject({ assigned: [{ id: connection.id }] })

      const badToken = await fetch(`${publicOrigin}/internal/provider-access`, {
        headers: { Authorization: "Bearer incorrect-account-capability" },
      })
      expect(badToken.status).toBe(401)

      const wrongOrigin = await fetch(`${publicOrigin}/internal/provider-access`, {
        headers: { Host: `wrong.example:${port}`, Authorization: "Bearer test-account-capability-value-123456" },
      })
      expect(wrongOrigin.status).toBe(421)

      const forbiddenAdmin = await fetch(`${publicOrigin}/api/admin/state`, {
        headers: { Authorization: `Bearer ${session.token}`, Origin: publicOrigin },
      })
      expect(forbiddenAdmin.status).toBe(403)

      const submit = await fetch(`${publicOrigin}/api/admin/provider-auth/claude/submit`, {
        method: "POST",
        headers: { Authorization: `Bearer ${adminSession.token}`, Origin: publicOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ code: "device-code" }),
      })
      expect(submit.status).toBe(200)
      expect(await submit.json()).toEqual({ ok: true })

      const providerError = await fetch(`${publicOrigin}/internal/providers/${connection.id}/v1/responses`, {
        method: "POST",
        headers: { Authorization: "Bearer test-account-capability-value-123456", "Content-Type": "application/json" },
        body: "{}",
      })
      expect(providerError.status).toBe(401)
      const errorText = await providerError.text()
      expect(errorText).not.toContain("test-provider-key")
      expect(await readFile(path.join(root, "state", "gateway-state.json"), "utf8")).not.toContain("test-user-password-123")
    } finally {
      gateway.server.stop(true)
      await rm(root, { recursive: true, force: true })
    }
  })
})
