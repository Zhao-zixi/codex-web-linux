import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RemoteWorkspaceSyncHelper } from "./helper"

const roots: string[] = []

async function createHelper() {
  const root = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-helper-test-"))
  roots.push(root)
  const dataDirectory = path.join(root, "data")
  const helper = new RemoteWorkspaceSyncHelper("https://workspace.example.test", dataDirectory)
  await helper.initialize()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => helper.handle(request, server.port, server.requestIP(request)?.address),
  })
  return { helper, server, root, url: `http://127.0.0.1:${server.port}` }
}

function headers(url: string, token: string, extra: Record<string, string> = {}) {
  return { Host: new URL(url).host, "X-Kanna-Token": token, ...extra }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe("local sync helper server", () => {
  test("binds authenticated API calls to the exact loopback host and origin", async () => {
    const { helper, server, url } = await createHelper()
    try {
      const html = await fetch(`${url}/`, { headers: { Host: new URL(url).host } })
      expect(html.status).toBe(200)
      expect(html.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
      expect(html.headers.get("x-frame-options")).toBe("DENY")
      expect(html.headers.get("x-content-type-options")).toBe("nosniff")
      expect(html.headers.get("referrer-policy")).toBe("no-referrer")

      const missingToken = await fetch(`${url}/api/status`, { headers: { Host: new URL(url).host } })
      expect(missingToken.status).toBe(401)
      const crossOrigin = await fetch(`${url}/api/status`, { headers: headers(url, helper.token, { Origin: "https://attacker.example.test" }) })
      expect(crossOrigin.status).toBe(403)
      const crossSite = await fetch(`${url}/api/status`, { headers: headers(url, helper.token, { "Sec-Fetch-Site": "cross-site" }) })
      expect(crossSite.status).toBe(403)
      const status = await fetch(`${url}/api/status`, { headers: headers(url, helper.token) })
      expect(status.status).toBe(200)
      expect(await status.json()).toMatchObject({ phase: "ready", sync: { state: "stopped" } })
      const foreignHost = await helper.handle(new Request(`${url}/api/status`, { headers: headers(url, helper.token, { Host: "localhost" }) }), server.port)
      expect(foreignHost.status).toBe(400)
    } finally {
      server.stop(true)
    }
  })

  test("lists directories without following symlinks and requires same-origin POSTs", async () => {
    const { helper, server, url, root } = await createHelper()
    try {
      const parent = path.join(root, "projects")
      const child = path.join(parent, "project with spaces")
      await mkdir(child, { recursive: true })
      if (process.platform !== "win32") await symlink(child, path.join(parent, "linked-project"))
      const browse = await fetch(`${url}/api/browse?path=${encodeURIComponent(parent)}`, { headers: headers(url, helper.token) })
      expect(browse.status).toBe(200)
      expect(await browse.json()).toEqual({ currentPath: parent, parentPath: root, entries: [{ name: "project with spaces", path: child }] })
      const denied = await fetch(`${url}/api/select-directory`, {
        method: "POST",
        headers: headers(url, helper.token, { "Content-Type": "application/json" }),
        body: JSON.stringify({ path: child }),
      })
      expect(denied.status).toBe(403)
      const selected = await fetch(`${url}/api/select-directory`, {
        method: "POST",
        headers: headers(url, helper.token, { Origin: url, "Content-Type": "application/json" }),
        body: JSON.stringify({ path: child }),
      })
      expect(selected.status).toBe(200)
      expect(await selected.json()).toEqual({ localDirectory: child })
    } finally {
      server.stop(true)
    }
  })

  test("logs out a Gateway admin token before rejecting its missing account and never persists credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-helper-auth-test-"))
    roots.push(root)
    const helper = new RemoteWorkspaceSyncHelper("https://workspace.example.test", path.join(root, "data"))
    await helper.initialize()
    const operations = helper as unknown as {
      installWindowsSsh: () => Promise<void>
      installMutagen: () => Promise<void>
      dependencies: () => Promise<{ ssh: boolean; sshKeygen: boolean; mutagen: boolean }>
    }
    operations.installWindowsSsh = async () => undefined
    operations.installMutagen = async () => undefined
    operations.dependencies = async () => ({ ssh: true, sshKeygen: true, mutagen: true })

    const originalFetch = globalThis.fetch
    const tokenFixture = "test-gateway-bearer-token-that-is-only-in-memory"
    const passwordFixture = "fixture-password-not-a-real-credential"
    const usernameFixture = "fixture-admin"
    const calls: Array<{ path: string; authorization?: string; body?: string }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      calls.push({ path: `${url.pathname}${url.search}`, authorization: new Headers(init?.headers).get("authorization") ?? undefined, body: typeof init?.body === "string" ? init.body : undefined })
      if (url.pathname === "/auth/login") {
        return Response.json({ token: tokenFixture, user: { username: usernameFixture, role: "admin" } })
      }
      if (url.pathname === "/auth/logout") return Response.json({ ok: true })
      throw new Error("Unexpected fixture request")
    }) as typeof fetch
    const input = { username: usernameFixture, password: passwordFixture, localDirectory: root }
    try {
      await expect(helper.start(input)).rejects.toThrow("workspace_unavailable")
      expect(input.password).toBe("")
      expect(calls.map((call) => call.path)).toEqual(["/auth/login", "/auth/logout?scope=session"])
      expect(calls[1]?.authorization).toBe(`Bearer ${tokenFixture}`)
      expect(calls[0]?.body).toContain(passwordFixture)

      const files = await readdir(path.join(root, "data"), { recursive: true })
      for (const relative of files) {
        const fullPath = path.join(root, "data", relative)
        const content = await readFile(fullPath).catch(() => Buffer.alloc(0))
        const text = content.toString("utf8")
        expect(text).not.toContain(passwordFixture)
        expect(text).not.toContain(tokenFixture)
        expect(text).not.toContain(usernameFixture)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("does not retain a failed Gateway password in memory or on disk", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-helper-auth-test-"))
    roots.push(root)
    const helper = new RemoteWorkspaceSyncHelper("https://workspace.example.test", path.join(root, "data"))
    await helper.initialize()
    const operations = helper as unknown as {
      installWindowsSsh: () => Promise<void>
      installMutagen: () => Promise<void>
      dependencies: () => Promise<{ ssh: boolean; sshKeygen: boolean; mutagen: boolean }>
    }
    operations.installWindowsSsh = async () => undefined
    operations.installMutagen = async () => undefined
    operations.dependencies = async () => ({ ssh: true, sshKeygen: true, mutagen: true })
    const originalFetch = globalThis.fetch
    const passwordFixture = "fixture-wrong-password-not-real"
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      calls.push(url.pathname)
      return Response.json({ error: "Invalid username or password" }, { status: 401 })
    }) as typeof fetch
    const input = { username: "fixture-user", password: passwordFixture, localDirectory: root }
    try {
      await expect(helper.start(input)).rejects.toThrow("invalid_credentials")
      expect(input.password).toBe("")
      expect(calls).toEqual(["/auth/login"])
      const files = await readdir(path.join(root, "data"), { recursive: true })
      for (const relative of files) {
        const content = await readFile(path.join(root, "data", relative)).catch(() => Buffer.alloc(0))
        expect(content.toString("utf8")).not.toContain(passwordFixture)
      }
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
