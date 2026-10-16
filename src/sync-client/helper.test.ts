import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultDataDirectory, RemoteWorkspaceSyncHelper, startLocalSyncServer } from "./helper"

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
  test("accepts the configured public HTTP origin as an exact origin", async () => {
    const helper = new RemoteWorkspaceSyncHelper("http://fnos.zixizhao.top:8444", path.join(os.tmpdir(), "kanna-sync-http-origin-test"))
    expect(helper.origin).toBe("http://fnos.zixizhao.top:8444")
    expect(() => new RemoteWorkspaceSyncHelper("http://fnos.zixizhao.top:8444/path")).toThrow("invalid_server_origin")
    expect(() => new RemoteWorkspaceSyncHelper("http://user@fnos.zixizhao.top:8444")).toThrow("invalid_server_origin")
  })

  test("supports isolated native smoke data and a private startup handoff without opening a browser", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-startup-test-"))
    roots.push(root)
    const original = {
      data: process.env.KANNA_SYNC_DATA_DIRECTORY,
      startup: process.env.KANNA_SYNC_STARTUP_FILE,
      noOpen: process.env.KANNA_SYNC_NO_OPEN,
    }
    const startupFile = path.join(root, "startup", "local.json")
    process.env.KANNA_SYNC_DATA_DIRECTORY = path.join(root, "isolated-data")
    process.env.KANNA_SYNC_STARTUP_FILE = startupFile
    process.env.KANNA_SYNC_NO_OPEN = "1"
    const helper = new RemoteWorkspaceSyncHelper("https://workspace.example.test", defaultDataDirectory())
    await helper.initialize()
    const { server, localUrl } = startLocalSyncServer(helper)
    try {
      const handoff = JSON.parse(await readFile(startupFile, "utf8")) as { localUrl: string }
      expect(defaultDataDirectory()).toBe(path.join(root, "isolated-data"))
      expect(handoff.localUrl).toBe(localUrl)
      expect(new URL(handoff.localUrl).hash.length).toBeGreaterThan(1)
      expect((await stat(startupFile)).mode & 0o077).toBe(0)
    } finally {
      server.stop(true)
      if (original.data === undefined) delete process.env.KANNA_SYNC_DATA_DIRECTORY
      else process.env.KANNA_SYNC_DATA_DIRECTORY = original.data
      if (original.startup === undefined) delete process.env.KANNA_SYNC_STARTUP_FILE
      else process.env.KANNA_SYNC_STARTUP_FILE = original.startup
      if (original.noOpen === undefined) delete process.env.KANNA_SYNC_NO_OPEN
      else process.env.KANNA_SYNC_NO_OPEN = original.noOpen
    }
  })

  test("keeps a real local control request open beyond Bun's default timeout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-sync-timeout-test-"))
    roots.push(root)
    const originalNoOpen = process.env.KANNA_SYNC_NO_OPEN
    process.env.KANNA_SYNC_NO_OPEN = "1"
    const helper = new RemoteWorkspaceSyncHelper("https://workspace.example.test", path.join(root, "data"))
    await helper.initialize()
    ;(helper as unknown as { control: () => Promise<unknown> }).control = async () => {
      await Bun.sleep(10_500)
      return { phase: "ready" }
    }
    const { server, localUrl } = startLocalSyncServer(helper)
    const url = new URL(localUrl)
    try {
      const response = await fetch(`${url.origin}/api/open-kanna`, {
        method: "POST",
        headers: { Host: url.host, Origin: url.origin, "X-Kanna-Token": url.hash.slice(1) },
      })
      expect(response.status).toBe(200)
    } finally {
      server.stop(true)
      if (originalNoOpen === undefined) delete process.env.KANNA_SYNC_NO_OPEN
      else process.env.KANNA_SYNC_NO_OPEN = originalNoOpen
    }
  }, 20_000)

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

  test("accepts bodyless control POSTs through the real HTTP handler", async () => {
    const { helper, server, url } = await createHelper()
    const actions: string[] = []
    ;(helper as unknown as { control: (action: string) => Promise<unknown> }).control = async (action) => {
      actions.push(action)
      return { phase: "ready" }
    }
    try {
      for (const action of ["pause", "resume", "restart", "open-kanna"]) {
        const response = await fetch(`${url}/api/${action}`, { method: "POST", headers: headers(url, helper.token, { Origin: url }) })
        expect(response.status).toBe(200)
      }
      expect(actions).toEqual(["pause", "resume", "restart", "open-kanna"])
    } finally {
      server.stop(true)
    }
  })

  test("returns accepted while a long-running start continues for status polling", async () => {
    const { helper, server, url, root } = await createHelper()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    ;(helper as unknown as { start: (input: unknown) => Promise<unknown> }).start = async () => {
      await pending
      return { phase: "active" }
    }
    try {
      const response = await fetch(`${url}/api/start`, {
        method: "POST",
        headers: headers(url, helper.token, { Origin: url, "Content-Type": "application/json" }),
        body: JSON.stringify({ username: "user", password: "test-only", localDirectory: root }),
      })
      expect(response.status).toBe(202)
      expect((await response.json()).phase).toBe("ready")
    } finally {
      finish()
      server.stop(true)
    }
  })

  test("rejects overlapping account starts instead of mixing their state", async () => {
    const { helper, server } = await createHelper()
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    ;(helper as unknown as { runStart: (input: unknown) => Promise<unknown> }).runStart = async () => pending
    try {
      const first = helper.start({})
      await expect(helper.start({})).rejects.toThrow("operation_in_progress")
      finish()
      await first
    } finally {
      server.stop(true)
    }
  })

  test("restart recreates a missing owned Mutagen session and clears stale errors", async () => {
    const { helper, server } = await createHelper()
    const operations = helper as unknown as {
      state: Record<string, unknown> | null
      writeSshConfig: () => Promise<void>
      mutagenSessions: () => Promise<unknown[]>
      ensureMutagenSession: () => Promise<void>
      readMutagenStatus: () => Promise<{ state: "connected"; summary: string; conflictCount: number; conflicts: []; raw: null }>
      error: string | null
    }
    operations.state = { sessionName: "owned-session", localDirectory: "/tmp/project", remotePath: "/workspace/project" }
    operations.writeSshConfig = async () => undefined
    operations.mutagenSessions = async () => []
    let created = 0
    operations.ensureMutagenSession = async () => { created++ }
    operations.readMutagenStatus = async () => ({ state: "connected", summary: "已连接", conflictCount: 0, conflicts: [], raw: null })
    operations.error = "ssh_connection_failed"
    try {
      const status = await helper.control("restart")
      expect(created).toBe(1)
      expect(status.phase).toBe("active")
      expect(status.error).toBeNull()
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

  test("rejects HOME and any local sync data directory overlap", async () => {
    const { helper, root } = await createHelper()
    const operations = helper as unknown as { isUnsafeLocalDirectory: (directory: string) => Promise<boolean> }
    const data = path.join(root, "data")
    await mkdir(path.join(data, "nested-project"), { recursive: true })
    expect(await operations.isUnsafeLocalDirectory(await realpath(os.homedir()))).toBe(true)
    expect(await operations.isUnsafeLocalDirectory(root)).toBe(true)
    expect(await operations.isUnsafeLocalDirectory(data)).toBe(true)
    expect(await operations.isUnsafeLocalDirectory(path.join(data, "nested-project"))).toBe(true)
    const unsafeStart = { username: "fixture-user", password: "fixture-password", localDirectory: path.join(data, "nested-project") }
    await expect(helper.start(unsafeStart)).rejects.toThrow("unsafe_local_directory")
    expect(unsafeStart.password).toBe("")
    const project = path.join(root, "projects", "safe-project")
    await mkdir(project, { recursive: true })
    expect(await operations.isUnsafeLocalDirectory(project)).toBe(false)
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
    const project = path.join(root, "project")
    await mkdir(project)
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
    const input = { username: usernameFixture, password: passwordFixture, localDirectory: project }
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
    const project = path.join(root, "project")
    await mkdir(project)
    const calls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
      calls.push(url.pathname)
      return Response.json({ error: "Invalid username or password" }, { status: 401 })
    }) as typeof fetch
    const input = { username: "fixture-user", password: passwordFixture, localDirectory: project }
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
