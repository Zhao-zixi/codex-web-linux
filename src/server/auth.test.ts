import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { persistProjectUpload } from "./uploads"
import { startKannaServer } from "./server"
import { createAuthManager, shouldRejectHostedCrossOrigin } from "./auth"
import type { HostedWorkspaceSnapshot } from "./hosted-workspace"

const tempDirs: string[] = []
const WebSocket = createRequire(import.meta.url)("ws") as new (
  address: string,
  protocols?: string | string[],
  options?: { headers?: Record<string, string> }
) => {
  protocol: string
  once(event: "open", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
  once(event: "close", listener: (code: number) => void): void
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startPasswordServer(options: { trustProxy?: boolean; port?: number; hostedWorkspace?: HostedWorkspaceSnapshot; remoteWorkspaceDeviceKeysDir?: string; remoteWorkspaceClientDirectory?: string } = {}) {
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-test-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-data-"))
  tempDirs.push(projectDir)
  tempDirs.push(dataDir)
  const server = await startKannaServer({
    dataDir,
    port: options.port ?? 0,
    strictPort: true,
    password: "secret",
    keybindingsPath: path.join(dataDir, "keybindings.json"),
    trustProxy: options.trustProxy ?? false,
    hostedWorkspace: options.hostedWorkspace ?? { enabled: false },
    remoteWorkspaceDeviceKeysDir: options.remoteWorkspaceDeviceKeysDir,
    remoteWorkspaceClientDirectory: options.remoteWorkspaceClientDirectory,
  })
  expect(server.port).toBeGreaterThan(0)
  const project = await server.store.openProject(projectDir, "Project")
  return { server, projectDir, project }
}

function extractCookie(response: Response) {
  const header = response.headers.get("set-cookie")
  expect(header).toBeTruthy()
  return header!.split(";", 1)[0]
}

describe("password auth", () => {
  test("rejects hosted cross-origin and null-origin state-changing browser requests", () => {
    const auth = createAuthManager("secret", { trustProxy: true })
    const request = (pathname: string, method: string, origin?: string) => new Request(`http://alice.example.test${pathname}`, {
      method,
      headers: {
        ...(origin === undefined ? {} : { Origin: origin }),
        "X-Forwarded-Proto": "https",
      },
    })

    expect(shouldRejectHostedCrossOrigin(request("/ws", "GET", "https://bob.example.test"), true, auth.validateOrigin)).toBe(true)
    expect(shouldRejectHostedCrossOrigin(request("/ws", "GET", "null"), true, auth.validateOrigin)).toBe(true)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "POST", "https://bob.example.test"), true, auth.validateOrigin)).toBe(true)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "DELETE", "null"), true, auth.validateOrigin)).toBe(true)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "POST", "https://alice.example.test"), true, auth.validateOrigin)).toBe(false)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "POST"), true, auth.validateOrigin)).toBe(false)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "POST", "https://bob.example.test"), false, auth.validateOrigin)).toBe(false)
    expect(shouldRejectHostedCrossOrigin(request("/api/projects", "GET", "https://bob.example.test"), true, auth.validateOrigin)).toBe(false)
  })

  test("serves the app shell to unauthenticated browser requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/chat/demo`, { headers: { Accept: "text/html" } })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-type")).toContain("text/html")
      expect(response.headers.get("origin-agent-cluster")).toBe("?1")
      expect(await response.text()).toContain('id="root"')
    } finally {
      await server.stop()
    }
  })

  test("serves health checks without authentication", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/health`, { redirect: "manual" })
      expect(response.status).toBe(200)
      expect(response.headers.get("origin-agent-cluster")).toBe("?1")
    } finally {
      await server.stop()
    }
  })

  test("blocks unauthenticated api requests", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/api/projects/project-1/uploads`, { redirect: "manual" })
      expect(response.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("protects and returns only configured hosted workspace connection details", async () => {
    const { server } = await startPasswordServer({
      hostedWorkspace: {
        displayName: "Remote",
        sshHost: "sync.example.test",
        sshPort: 2222,
        sshUser: "kanna",
        workspaceRoot: "/workspace",
      },
    })

    try {
      const denied = await fetch(`http://localhost:${server.port}/api/hosted-workspace`)
      expect(denied.status).toBe(401)
      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: { "Content-Type": "application/json", Origin: `http://localhost:${server.port}` },
      })
      const response = await fetch(`http://localhost:${server.port}/api/hosted-workspace`, { headers: { Cookie: extractCookie(loginResponse) } })
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(await response.json()).toEqual({
        displayName: "Remote",
        sshHost: "sync.example.test",
        sshPort: 2222,
        sshUser: "kanna",
        workspaceRoot: "/workspace",
      })
    } finally {
      await server.stop()
    }
  })

  test("registers, lists, and revokes hosted workspace devices behind the app auth session", async () => {
    const deviceKeysDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-device-keys-"))
    tempDirs.push(deviceKeysDir)
    const { server } = await startPasswordServer({
      remoteWorkspaceDeviceKeysDir: deviceKeysDir,
      hostedWorkspace: {
        displayName: "Remote",
        sshHost: "sync.example.test",
        sshPort: 2222,
        sshUser: "workspace",
        workspaceRoot: "/workspace",
      },
    })
    const url = `http://localhost:${server.port}`
    const login = await fetch(`${url}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ password: "secret" }),
      headers: { "Content-Type": "application/json", Origin: url },
    })
    const cookie = extractCookie(login)
    const algorithm = Buffer.from("ssh-ed25519")
    const blob = Buffer.alloc(4 + algorithm.length + 4 + 32)
    blob.writeUInt32BE(algorithm.length, 0)
    algorithm.copy(blob, 4)
    blob.writeUInt32BE(32, 4 + algorithm.length)
    blob.fill(4, 8 + algorithm.length)
    const publicKey = `ssh-ed25519 ${blob.toString("base64")}`

    try {
      const unauthorized = await fetch(`${url}/api/hosted-workspace/devices`)
      expect(unauthorized.status).toBe(401)

      const register = () => fetch(`${url}/api/hosted-workspace/devices`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: url, "Content-Type": "application/json" },
        body: JSON.stringify({ publicKey, label: "Laptop" }),
      })
      const created = await register()
      expect(created.status).toBe(200)
      expect(await created.json()).toMatchObject({ authorized: true })
      const duplicate = await register()
      expect(await duplicate.json()).toEqual(await (async () => {
        const first = await fetch(`${url}/api/hosted-workspace/devices`, { headers: { Cookie: cookie } })
        const { devices } = await first.json() as { devices: Array<{ id: string }> }
        return { deviceId: devices[0]!.id, authorized: true }
      })())

      const listed = await fetch(`${url}/api/hosted-workspace/devices`, { headers: { Cookie: cookie } })
      expect(listed.status).toBe(200)
      const { devices } = await listed.json() as { devices: Array<{ id: string; label: string; fingerprint: string; createdAt: string }> }
      expect(devices).toHaveLength(1)
      expect(devices[0]).toMatchObject({ label: "Laptop" })
      expect(devices[0]!.fingerprint).toMatch(/^SHA256:/)
      expect(Number.isNaN(Date.parse(devices[0]!.createdAt))).toBe(false)

      const revoked = await fetch(`${url}/api/hosted-workspace/devices/${devices[0]!.id}`, {
        method: "DELETE",
        headers: { Cookie: cookie, Origin: url },
      })
      expect(revoked.status).toBe(204)
      expect(await (await fetch(`${url}/api/hosted-workspace/devices`, { headers: { Cookie: cookie } })).json()).toEqual({ devices: [] })
    } finally {
      await server.stop()
    }
  })

  test("lists only available remote workspace clients and streams downloads behind app auth", async () => {
    const clientDir = await mkdtemp(path.join(tmpdir(), "kanna-auth-client-artifacts-"))
    tempDirs.push(clientDir)
    await mkdir(clientDir, { recursive: true })
    const linuxZip = Buffer.from("synthetic-linux-zip")
    await writeFile(path.join(clientDir, "kanna-sync-linux-x64.zip"), linuxZip)
    const { server } = await startPasswordServer({
      trustProxy: true,
      remoteWorkspaceClientDirectory: clientDir,
      hostedWorkspace: {
        displayName: "Remote",
        sshHost: "sync.example.test",
        sshPort: 2222,
        sshUser: "workspace",
        workspaceRoot: "/workspace",
        authMode: "bearer",
        webHost: "alice.example.test",
        webPort: 443,
        webOrigin: "https://alice.example.test",
      },
    })
    const url = `http://localhost:${server.port}`
    const origin = "https://alice.example.test"
    const hostedFetch = (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      headers.set("Host", "alice.example.test")
      headers.set("X-Forwarded-Proto", "https")
      return fetch(`${url}${pathname}`, { ...init, headers })
    }

    try {
      const denied = await hostedFetch("/api/hosted-workspace/client")
      expect(denied.status).toBe(401)
      const login = await hostedFetch("/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: "secret" }),
        headers: { "Content-Type": "application/json", Origin: origin },
      })
      const { token } = await login.json() as { token: string }
      const authorization = { Authorization: `Bearer ${token}`, Origin: origin }
      const metadataResponse = await hostedFetch("/api/hosted-workspace/client", { headers: authorization })
      expect(metadataResponse.status).toBe(200)
      expect(await metadataResponse.json()).toEqual({
        serverOrigin: "https://alice.example.test",
        downloads: [{
          target: "linux-x64",
          label: "Linux x64",
          filename: "kanna-sync-linux-x64.zip",
          url: "/api/hosted-workspace/client/download/linux-x64",
        }],
      })
      const download = await hostedFetch("/api/hosted-workspace/client/download/linux-x64", { headers: authorization })
      expect(download.status).toBe(200)
      expect(download.headers.get("content-type")).toBe("application/zip")
      expect(download.headers.get("content-disposition")).toContain("kanna-sync-linux-x64.zip")
      expect(Buffer.from(await download.arrayBuffer())).toEqual(linuxZip)
      const missing = await hostedFetch("/api/hosted-workspace/client/download/windows-x64", { headers: authorization })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toEqual({ error: "sync_client_unavailable" })
    } finally {
      await server.stop()
    }
  })

  test("redirects /auth/login back into the app", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2Fchat%2Fdemo`, { redirect: "manual" })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/chat/demo`)
    } finally {
      await server.stop()
    }
  })

  test("sets a session cookie after a successful login", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(200)
      expect(extractCookie(response)).toContain("kanna_session=")
    } finally {
      await server.stop()
    }
  })

  test("uses origin-bound bearer sessions without cookie fallback in shared-host mode", async () => {
    const port = 54324
    const { server } = await startPasswordServer({
      port: 0,
      trustProxy: true,
      hostedWorkspace: {
        displayName: "elim",
        sshHost: "fnos.example.test",
        sshPort: 2222,
        sshUser: "workspace",
        workspaceRoot: "/workspace",
        authMode: "bearer",
        webHost: "localhost",
        webPort: port,
        webOrigin: `https://localhost:${port}`,
      },
    })
    const origin = `https://localhost:${port}`
    const url = `http://localhost:${server.port}`
    const hostedFetch = (pathname: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      headers.set("Host", `localhost:${port}`)
      return fetch(`${url}${pathname}`, { ...init, headers })
    }

    try {
      const login = await hostedFetch("/auth/login", {
        method: "POST",
        headers: { Origin: origin, "X-Forwarded-Proto": "https", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "secret" }),
      })
      expect(login.status).toBe(200)
      expect(login.headers.get("set-cookie")).toBeNull()
      const loginPayload = await login.json() as { token: string; expiresAt: number }
      expect(loginPayload.token).toMatch(/^[A-Za-z0-9_-]{32,128}$/)
      expect(loginPayload.expiresAt).toBeGreaterThan(Date.now())

      const cookieOnlyStatus = await hostedFetch("/auth/status", {
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Cookie: `kanna_session=${loginPayload.token}` },
      })
      expect(await cookieOnlyStatus.json()).toEqual({ enabled: true, authenticated: false, authMode: "bearer" })

      const cookieOnlyApi = await hostedFetch("/api/hosted-workspace", {
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Cookie: `kanna_session=${loginPayload.token}` },
      })
      expect(cookieOnlyApi.status).toBe(401)

      const bearerApi = await hostedFetch("/api/hosted-workspace", {
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(bearerApi.status).toBe(200)
      expect(await bearerApi.json()).toMatchObject({ authMode: "bearer", webOrigin: origin })
      const bearerWithoutOrigin = await hostedFetch("/api/hosted-workspace", {
        headers: { "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(bearerWithoutOrigin.status).toBe(200)

      const crossPort = await hostedFetch("/api/hosted-workspace", {
        headers: { Origin: "https://localhost:54325", "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(crossPort.status).toBe(401)

      const ticketResponse = await hostedFetch("/auth/ws-ticket", {
        method: "POST",
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(ticketResponse.status).toBe(200)
      const { ticket } = await ticketResponse.json() as { ticket: string }
      const ws = new WebSocket(`ws://localhost:${server.port}/ws`, ["kanna.ws.v1", `kanna.ticket.${ticket}`], {
        headers: { Host: `localhost:${port}`, Origin: origin, "X-Forwarded-Proto": "https" },
      })
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve)
        ws.once("error", reject)
      })
      expect(ws.protocol).toBe("kanna.ws.v1")
      expect(ws.protocol).not.toContain(ticket)
      const closeCode = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)))

      const logout = await hostedFetch("/auth/logout", {
        method: "POST",
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(logout.status).toBe(200)
      expect(logout.headers.get("set-cookie")).toBeNull()
      expect(await closeCode).toBe(1008)
      const afterLogout = await hostedFetch("/api/hosted-workspace", {
        headers: { Origin: origin, "X-Forwarded-Proto": "https", Authorization: `Bearer ${loginPayload.token}` },
      })
      expect(afterLogout.status).toBe(401)
    } finally {
      await server.stop()
    }
  })

  test("consumes a bearer WebSocket ticket once and binds it to origin and session expiry", async () => {
    const auth = createAuthManager("secret", { mode: "bearer", trustProxy: true, sessionTtlMs: 1000 })
    const origin = "https://fnos.example.test:8444"
    const request = (url: string, headers: Record<string, string>) => new Request(url, {
      headers: { "X-Forwarded-Proto": "https", ...headers },
    })
    const loginRequest = new Request("http://fnos.example.test:8444/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret" }),
      headers: {
        "X-Forwarded-Proto": "https",
        Origin: origin,
        "Content-Type": "application/json",
      },
    })
    const login = await auth.handleLogin(loginRequest, "/")
    const { token } = await login.json() as { token: string }
    expect(login.headers.get("set-cookie")).toBeNull()

    const ticketResponse = auth.handleWebSocketTicket(request("http://fnos.example.test:8444/auth/ws-ticket", {
      Origin: origin,
      Authorization: `Bearer ${token}`,
    }))
    expect(ticketResponse.status).toBe(200)
    const { ticket } = await ticketResponse.json() as { ticket: string }
    expect(ticketResponse.headers.get("cache-control")).toBe("no-store")
    const upgrade = (hostPort: string) => request(`http://${hostPort}/ws`, {
      Origin: `https://${hostPort}`,
      "Sec-WebSocket-Protocol": `kanna.ws.v1, kanna.ticket.${ticket}`,
    })
    expect(auth.consumeWebSocketTicket(upgrade("fnos.example.test:8445"))).toBeNull()
    expect(auth.consumeWebSocketTicket(upgrade("fnos.example.test:8444"))).toBeNull()

    const secondResponse = auth.handleWebSocketTicket(request("http://fnos.example.test:8444/auth/ws-ticket", {
      Origin: origin,
      Authorization: `Bearer ${token}`,
    }))
    const secondTicket = (await secondResponse.json() as { ticket: string }).ticket
    const secondUpgrade = request("http://fnos.example.test:8444/ws", {
      Origin: origin,
      "Sec-WebSocket-Protocol": `kanna.ws.v1, kanna.ticket.${secondTicket}`,
    })
    const sessionId = auth.consumeWebSocketTicket(secondUpgrade)
    expect(sessionId).toBeTruthy()
    expect(auth.isSessionActive(sessionId!, origin)).toBe(true)
    expect(auth.consumeWebSocketTicket(secondUpgrade)).toBeNull()

    const logout = auth.handleLogout(request("http://fnos.example.test:8444/auth/logout", {
      Origin: origin,
      Authorization: `Bearer ${token}`,
    }))
    expect(logout.headers.get("set-cookie")).toBeNull()
    expect(auth.isSessionActive(sessionId!, origin)).toBe(false)

    const expiredAuth = createAuthManager("secret", { mode: "bearer", trustProxy: true, sessionTtlMs: 1 })
    const shortLogin = await expiredAuth.handleLogin(new Request("http://fnos.example.test:8444/auth/login", {
      method: "POST",
      body: JSON.stringify({ password: "secret" }),
      headers: { Origin: origin, "X-Forwarded-Proto": "https", "Content-Type": "application/json" },
    }), "/")
    const shortToken = (await shortLogin.json() as { token: string }).token
    await Bun.sleep(3)
    expect(expiredAuth.handleWebSocketTicket(request("http://fnos.example.test:8444/auth/ws-ticket", {
      Origin: origin,
      Authorization: `Bearer ${shortToken}`,
    })).status).toBe(401)
  })

  test("rejects an invalid password", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "wrong", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(response.status).toBe(401)
      expect(response.headers.get("set-cookie")).toBeNull()
    } finally {
      await server.stop()
    }
  })

  test("rejects cross-origin login attempts", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "http://evil.test",
        },
      })

      expect(response.status).toBe(403)
    } finally {
      await server.stop()
    }
  })

  test("allows authenticated access to protected routes", async () => {
    const { server, project, projectDir } = await startPasswordServer()

    try {
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)

      const contentResponse = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(contentResponse.status).toBe(200)
      expect(await contentResponse.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("ignores forwarded proto when trustProxy is off", async () => {
    const { server } = await startPasswordServer()

    try {
      const response = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: "https://evil.test",
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(403)

      const goodLoginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(goodLoginResponse.status).toBe(200)
      const cookieHeader = goodLoginResponse.headers.get("set-cookie") ?? ""
      expect(cookieHeader).not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("honors forwarded proto when trustProxy is on", async () => {
    const { server } = await startPasswordServer({ trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "https",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`https://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `https://localhost:${server.port}`,
          "X-Forwarded-Proto": "https",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").toContain("Secure")

      const evilResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      expect(evilResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })

  test("ignores invalid forwarded proto values", async () => {
    const { server } = await startPasswordServer({ trustProxy: true })

    try {
      const redirect = await fetch(`http://localhost:${server.port}/auth/login?next=%2F`, {
        redirect: "manual",
        headers: {
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get("location")).toBe(`http://localhost:${server.port}/`)

      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
          "X-Forwarded-Proto": "ftp",
        },
      })
      expect(loginResponse.status).toBe(200)
      expect(loginResponse.headers.get("set-cookie") ?? "").not.toContain("Secure")
    } finally {
      await server.stop()
    }
  })

  test("clears the session cookie on logout", async () => {
    const { server } = await startPasswordServer()

    try {
      const loginResponse = await fetch(`http://localhost:${server.port}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ password: "secret", next: "/" }),
        headers: {
          "Content-Type": "application/json",
          Origin: `http://localhost:${server.port}`,
        },
      })
      const cookie = extractCookie(loginResponse)

      const logoutResponse = await fetch(`http://localhost:${server.port}/auth/logout`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: `http://localhost:${server.port}`,
        },
      })

      expect(logoutResponse.status).toBe(200)
      expect(logoutResponse.headers.get("set-cookie")).toContain("Max-Age=0")

      const healthResponse = await fetch(`http://localhost:${server.port}/health`, {
        headers: {
          Cookie: cookie,
        },
      })
      expect(healthResponse.status).toBe(200)
    } finally {
      await server.stop()
    }
  })
})
