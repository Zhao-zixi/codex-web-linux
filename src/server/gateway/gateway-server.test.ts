import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fixedUpstreamUrl } from "./gateway-server"
import { startGatewayServer } from "./gateway-server"
import type { AdminProviderAuthStatus } from "../../shared/gateway-api"

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

test("native connections probe the live provider profile and fail visibly when revoke delivery fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kanna-native-gateway-"))
  const probe = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  const origin = `http://127.0.0.1:${port}`
  const tokenPath = path.join(root, "account-token")
  const passwordPath = path.join(root, "app-password")
  const secondTokenPath = path.join(root, "zzx-account-token")
  const secondPasswordPath = path.join(root, "zzx-app-password")
  await writeFile(tokenPath, "test-account-capability-value-123456", { mode: 0o600 })
  await writeFile(passwordPath, "unused-workspace-password", { mode: 0o600 })
  await writeFile(secondTokenPath, "test-second-account-capability-123456", { mode: 0o600 })
  await writeFile(secondPasswordPath, "unused-second-workspace-password", { mode: 0o600 })
  await mkdir(path.join(root, "client"), { recursive: true })
  await writeFile(path.join(root, "client", "index.html"), "gateway")
  let revokeCalls = 0
  let failRevokes = true
  let signalRevokeStarted!: () => void
  let revokeStarted = new Promise<void>((resolve) => { signalRevokeStarted = resolve })
  let holdNativeToken = false
  let signalNativeTokenStarted!: () => void
  let releaseNativeToken!: () => void
  let nativeTokenStarted = new Promise<void>((resolve) => { signalNativeTokenStarted = resolve })
  let nativeTokenWait = new Promise<void>((resolve) => { releaseNativeToken = resolve })
  const providerStatus: AdminProviderAuthStatus = {
    id: "codex", installed: true, authStatus: "signed_out", shareable: false,
    flow: { phase: "idle" },
  }
  const gateway = await startGatewayServer({
    publicOrigin: origin,
    internalOrigin: origin,
    accounts: [
      { id: "elim", appUrl: "http://kanna_elim:3210", appPasswordFile: passwordPath, accountTokenFile: tokenPath },
      { id: "zzx", appUrl: "http://kanna_zzx:3210", appPasswordFile: secondPasswordPath, accountTokenFile: secondTokenPath },
    ],
    stateDirectory: path.join(root, "state"),
    adminHomeDirectory: path.join(root, "admin-home"),
    clientDirectory: path.join(root, "client"), host: "127.0.0.1", port,
    providerControl: {
      getStatuses: async () => [providerStatus],
      start: async () => undefined, submit: async () => undefined, cancel: async () => undefined,
      logout: async () => undefined, install: async () => undefined,
      getNativeToken: async () => {
        if (holdNativeToken) {
          holdNativeToken = false
          signalNativeTokenStarted()
          await nativeTokenWait
        }
        return { provider: "codex", accessToken: "short-access", expiresAt: Date.now() + 60_000, chatgptAccountId: "acct-1" }
      },
    },
    providerFetch: async () => {
      revokeCalls += 1
      signalRevokeStarted()
      return failRevokes ? Response.json({ error: "offline" }, { status: 503 }) : Response.json({ ok: true })
    },
  })
  try {
    const admin = await gateway.store.createUser({ username: "admin", password: "test-admin-password-123", role: "admin" })
    const user = await gateway.store.createUser({ username: "elim", password: "test-user-password-123", role: "user", accountId: "elim" })
    const secondUser = await gateway.store.createUser({ username: "zzx", password: "test-second-user-password-123", role: "user", accountId: "zzx" })
    const adminSession = await gateway.store.createSession(admin.id, 60_000)
    await gateway.store.createSession(user.id, 60_000)
    const created = await fetch(`${origin}/api/admin/connections`, {
      method: "POST", headers: { Authorization: `Bearer ${adminSession.token}`, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "native", name: "Admin Codex", provider: "codex" }),
    })
    expect(created.status).toBe(201)
    const connection = await created.json() as { id: string; kind: string; shareable: boolean }
    expect(connection).toMatchObject({ kind: "native", shareable: false })
    await gateway.store.setUserConnections(user.id, [connection.id])
    await gateway.store.setUserConnections(secondUser.id, [connection.id])
    const tokenResponse = await fetch(`${origin}/internal/providers/${connection.id}/native-token`, {
      method: "POST", headers: { Authorization: "Bearer test-account-capability-value-123456", "Content-Type": "application/json" }, body: "{}",
    })
    expect(tokenResponse.status).toBe(200)
    expect(tokenResponse.headers.get("cache-control")).toBe("no-store")
    expect(await tokenResponse.json()).toMatchObject({ provider: "codex", accessToken: "short-access", chatgptAccountId: "acct-1" })
    holdNativeToken = true
    nativeTokenStarted = new Promise<void>((resolve) => { signalNativeTokenStarted = resolve })
    nativeTokenWait = new Promise<void>((resolve) => { releaseNativeToken = resolve })
    const racingTokenResponse = fetch(`${origin}/internal/providers/${connection.id}/native-token`, {
      method: "POST", headers: { Authorization: "Bearer test-account-capability-value-123456", "Content-Type": "application/json" }, body: "{}",
    })
    await nativeTokenStarted
    await gateway.store.setUserConnections(user.id, [])
    releaseNativeToken()
    expect((await racingTokenResponse).status).toBe(401)
    await gateway.store.setUserConnections(user.id, [connection.id])
    const disabled = await fetch(`${origin}/api/admin/connections/${connection.id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${adminSession.token}`, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    })
    expect(disabled.status).toBe(503)
    expect(revokeCalls).toBe(4)
    await gateway.store.updateConnection(connection.id, { enabled: true })
    failRevokes = false
    holdNativeToken = true
    nativeTokenStarted = new Promise<void>((resolve) => { signalNativeTokenStarted = resolve })
    nativeTokenWait = new Promise<void>((resolve) => { releaseNativeToken = resolve })
    const tokenDuringLogout = fetch(`${origin}/internal/providers/${connection.id}/native-token`, {
      method: "POST", headers: { Authorization: "Bearer test-account-capability-value-123456", "Content-Type": "application/json" }, body: "{}",
    })
    await nativeTokenStarted
    revokeStarted = new Promise<void>((resolve) => { signalRevokeStarted = resolve })
    const logout = fetch(`${origin}/api/admin/provider-auth/codex/logout`, {
      method: "POST", headers: { Authorization: `Bearer ${adminSession.token}`, Origin: origin },
    })
    await revokeStarted
    releaseNativeToken()
    expect((await tokenDuringLogout).status).toBe(401)
    expect((await logout).status).toBe(200)
    expect((await fetch(`${origin}/internal/providers/${connection.id}/native-token`, {
      method: "POST", headers: { Authorization: "Bearer test-account-capability-value-123456", "Content-Type": "application/json" }, body: "{}",
    })).status).toBe(401)
  } finally {
    gateway.server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
})
