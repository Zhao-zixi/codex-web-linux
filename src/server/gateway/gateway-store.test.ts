import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GatewayStore } from "./gateway-store"

const temporaryDirectories: string[] = []

async function createStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kanna-gateway-store-"))
  temporaryDirectories.push(directory)
  return { directory, store: new GatewayStore(directory) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("GatewayStore", () => {
  test("hashes passwords, redacts connection credentials, and creates private state", async () => {
    const { directory, store } = await createStore()
    const user = await store.createUser({ username: "elim", password: "old-workspace-secret-123", role: "user", accountId: "elim" })
    const connection = await store.createConnection({ name: "Primary", provider: "codex", apiKey: "provider-secret-value" })
    await store.setUserConnections(user.id, [connection.id])

    expect(user).not.toHaveProperty("passwordHash")
    expect(await store.listConnections()).not.toContain("provider-secret-value")
    expect(JSON.stringify(await store.listConnections())).not.toContain("provider-secret-value")
    expect(await store.getAssignedConnections(user.id)).toEqual([connection])

    const directoryInfo = await stat(directory)
    const stateText = await readFile(path.join(directory, "gateway-state.json"), "utf8")
    const stateInfo = await stat(path.join(directory, "gateway-state.json"))
    expect(directoryInfo.mode & 0o777).toBe(0o700)
    expect(stateInfo.mode & 0o777).toBe(0o600)
    expect(stateText).not.toContain("old-workspace-secret-123")
    expect(stateText).toContain("$argon2id$")
  })

  test("password reset and disable invalidate existing sessions", async () => {
    const { store } = await createStore()
    const user = await store.createUser({ username: "elim", password: "old-workspace-secret-123", role: "user", accountId: "elim" })
    const session = await store.createSession(user.id, 60_000)
    expect(await store.resolveSession(session.token)).not.toBeNull()

    await store.setUserPassword(user.id, "new-workspace-secret-456")
    expect(await store.resolveSession(session.token)).toBeNull()
    const updatedSession = await store.createSession(user.id, 60_000)
    await store.setUserEnabled(user.id, false)
    expect(await store.resolveSession(updatedSession.token)).toBeNull()
  })

  test("workspace-account assignment is isolated and administrators receive no managed grants", async () => {
    const { store } = await createStore()
    const elim = await store.createUser({ username: "elim", password: "old-workspace-secret-123", role: "user", accountId: "elim" })
    await store.createUser({ username: "zzx", password: "old-workspace-secret-456", role: "user", accountId: "zzx" })
    const admin = await store.createUser({ username: "admin", password: "admin-workspace-secret-789", role: "admin" })
    const connection = await store.createConnection({ name: "Claude", provider: "claude", apiKey: "provider-secret-value" })
    await store.setUserConnections(elim.id, [connection.id])

    expect((await store.getAssignedConnectionsForAccount("elim")).map(({ id }) => id)).toEqual([connection.id])
    expect(await store.getAssignedConnectionsForAccount("zzx")).toEqual([])
    expect(await store.getAssignedConnections(admin.id)).toEqual([])
    expect(await store.setUserConnections(admin.id, [connection.id])).toBeNull()
  })

  test("creates one native connection per provider without storing credentials and never revives disabled entries", async () => {
    const { store, directory } = await createStore()
    const user = await store.createUser({ username: "elim", password: "old-workspace-secret-123", role: "user", accountId: "elim" })
    const first = await store.createNativeConnection({ name: "Admin Codex", provider: "codex" })
    const duplicate = await store.createNativeConnection({ name: "Renamed", provider: "codex" })
    expect(duplicate).toEqual(first)
    expect(first).toMatchObject({ kind: "native", provider: "codex", shareable: false, enabled: true })
    const state = JSON.parse(await readFile(path.join(directory, "gateway-state.json"), "utf8")) as { connections: Array<Record<string, unknown>> }
    expect(state.connections[0]).toMatchObject({ profileId: "admin", kind: "native" })
    expect(state.connections[0]).not.toHaveProperty("apiKey")

    await store.setUserConnections(user.id, [first.id])
    expect((await store.getAssignedConnectionsForAccount("elim"))[0]).not.toHaveProperty("apiKey")
    await store.updateConnection(first.id, { enabled: false })
    expect(await store.getAssignedConnectionsForAccount("elim")).toEqual([])
    expect((await store.createNativeConnection({ name: "Admin Codex", provider: "codex" })).enabled).toBe(false)
  })

  test("normalizes legacy API connections without a kind", async () => {
    const { store, directory } = await createStore()
    const user = await store.createUser({ username: "elim", password: "old-workspace-secret-123", role: "user", accountId: "elim" })
    const api = await store.createConnection({ name: "API", provider: "codex", apiKey: "provider-secret-value" })
    await store.setUserConnections(user.id, [api.id])
    const statePath = path.join(directory, "gateway-state.json")
    const state = JSON.parse(await readFile(statePath, "utf8")) as { connections: Array<Record<string, unknown>> }
    delete state.connections[0]!.kind
    await Bun.write(statePath, JSON.stringify(state))
    const legacyStore = new GatewayStore(directory)
    expect((await legacyStore.listConnections())[0]).toMatchObject({ kind: "api_key", shareable: true })
    expect((await legacyStore.getAssignedConnectionsForAccount("elim"))[0]).toMatchObject({ kind: "api_key", apiKey: "provider-secret-value" })
  })

  test("fails closed when persisted connection state has an invalid type", async () => {
    const { directory, store } = await createStore()
    await store.listUsers()
    const statePath = path.join(directory, "gateway-state.json")
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>
    state.connections = { unexpected: true }
    await Bun.write(statePath, JSON.stringify(state))
    await expect(new GatewayStore(directory).listUsers()).rejects.toThrow("Unsupported or invalid gateway state")
  })
})
