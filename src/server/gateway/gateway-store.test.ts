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
})
