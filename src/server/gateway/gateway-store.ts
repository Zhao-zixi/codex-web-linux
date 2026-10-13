import { createHash, randomBytes } from "node:crypto"
import { chmod, chown, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import type { GatewayRole, GatewayUserSummary, ManagedConnectionSummary, ManagedProvider } from "../../shared/gateway-api"

export type { GatewayRole } from "../../shared/gateway-api"

export type GatewayUser = GatewayUserSummary

interface StoredGatewayUser extends GatewayUser {
  createdAt: number
  authVersion: number
  passwordHash: string
}

export interface GatewaySession {
  tokenHash: string
  userId: string
  authVersion: number
  createdAt: number
  expiresAt: number
}

interface StoredManagedConnection {
  id: string
  name: string
  provider: ManagedProvider
  enabled: boolean
  apiKey: string
  createdAt: number
}

export interface GatewayState {
  version: 1
  users: StoredGatewayUser[]
  sessions: GatewaySession[]
  connections: StoredManagedConnection[]
}

const USERNAME = /^[a-z][a-z0-9_-]{0,31}$/
const SESSION_BYTES = 32

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

function validateUserInput(user: Pick<GatewayUser, "username" | "role" | "accountId">) {
  if (!USERNAME.test(user.username)) throw new Error("Invalid gateway username")
  if (user.role !== "admin" && user.role !== "user") throw new Error("Invalid gateway role")
  if (user.role === "admin" && user.accountId !== undefined) throw new Error("Admin users cannot be bound to a workspace account")
  if (user.role === "user" && (!user.accountId || !USERNAME.test(user.accountId))) throw new Error("User accounts must be bound to a valid workspace account")
}

/**
 * Private, single-process gateway identity store. Passwords are Argon2id
 * hashes; browser bearer values are never persisted, only their SHA-256 hashes.
 */
export class GatewayStore {
  private state: GatewayState | null = null
  private writeQueue: Promise<void> = Promise.resolve()
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(private readonly stateDirectory: string, private readonly owner?: { uid: number; gid: number }) {}

  private get statePath() {
    return path.join(this.stateDirectory, "gateway-state.json")
  }

  private async loadState(): Promise<GatewayState> {
    if (this.state) return structuredClone(this.state)
    await this.ensurePrivateDirectory()
    try {
      const fileInfo = await lstat(this.statePath)
      if (fileInfo.isSymbolicLink() || !fileInfo.isFile() || (fileInfo.mode & 0o077) !== 0) {
        throw new Error("Gateway state file must be a private regular file")
      }
      if (this.owner && typeof process.getuid === "function" && process.getuid() === 0 &&
        (fileInfo.uid !== this.owner.uid || fileInfo.gid !== this.owner.gid)) {
        await chown(this.statePath, this.owner.uid, this.owner.gid)
      }
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as GatewayState
      if (parsed.version !== 1 || !Array.isArray(parsed.users) || !Array.isArray(parsed.sessions) || !Array.isArray(parsed.connections)) {
        throw new Error("Unsupported or invalid gateway state")
      }
      this.validateState(parsed)
      this.state = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      this.state = { version: 1, users: [], sessions: [], connections: [] }
      await this.persist(this.state)
    }
    return structuredClone(this.state)
  }

  async listUsers(): Promise<GatewayUser[]> {
    const state = await this.loadState()
    return state.users.map((user) => this.publicUser(user))
  }

  async findUser(username: string): Promise<GatewayUser | null> {
    const state = await this.loadState()
    const user = state.users.find((candidate) => candidate.username === username)
    return user ? this.publicUser(user) : null
  }

  async createUser(args: {
    username: string
    password: string
    role: GatewayRole
    accountId?: string
  }): Promise<GatewayUser> {
    validateUserInput(args)
    if (args.password.length < 12) throw new Error("Gateway passwords must be at least 12 characters")
    return this.withMutation(async () => {
      const state = await this.loadState()
      if (state.users.some((user) => user.username === args.username)) throw new Error("Gateway username already exists")
      const user: StoredGatewayUser = {
        id: randomBytes(16).toString("hex"),
        username: args.username,
        role: args.role,
        ...(args.accountId ? { accountId: args.accountId } : {}),
        enabled: true,
        connectionIds: [],
        passwordHash: await Bun.password.hash(args.password, { algorithm: "argon2id" }),
        authVersion: 1,
        createdAt: Date.now(),
      }
      state.users.push(user)
      await this.persist(state)
      return this.publicUser(user)
    })
  }

  async verifyPassword(username: string, password: string): Promise<GatewayUser | null> {
    return (await this.verifyPasswordWithVersion(username, password))?.user ?? null
  }

  async verifyPasswordWithVersion(username: string, password: string) {
    const state = await this.loadState()
    const user = state.users.find((candidate) => candidate.username === username && candidate.enabled)
    if (!user || !await Bun.password.verify(password, user.passwordHash)) return null
    const current = (await this.loadState()).users.find((candidate) => candidate.id === user.id)
    if (!current?.enabled || current.authVersion !== user.authVersion || current.passwordHash !== user.passwordHash) return null
    return { user: this.publicUser(user), authVersion: user.authVersion }
  }

  async createSession(userId: string, ttlMs: number, now = Date.now(), expectedAuthVersion?: number) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Session lifetime must be positive")
    return this.withMutation(async () => {
      const state = await this.loadState()
      const user = state.users.find((candidate) => candidate.id === userId && candidate.enabled)
      if (!user || (expectedAuthVersion !== undefined && user.authVersion !== expectedAuthVersion)) throw new Error("Gateway user is unavailable")
      const token = randomBytes(SESSION_BYTES).toString("base64url")
      const session: GatewaySession = {
        tokenHash: hashSessionToken(token),
        userId,
        authVersion: user.authVersion,
        createdAt: now,
        expiresAt: now + ttlMs,
      }
      state.sessions = state.sessions.filter((item) => item.expiresAt > now)
      state.sessions.push(session)
      await this.persist(state)
      return { token, expiresAt: session.expiresAt }
    })
  }

  async resolveSession(token: string, now = Date.now()): Promise<{ session: GatewaySession; user: GatewayUser } | null> {
    if (!token || token.length > 256) return null
    return this.resolveSessionHash(hashSessionToken(token), now)
  }

  async resolveSessionHash(tokenHash: string, now = Date.now()): Promise<{ session: GatewaySession; user: GatewayUser } | null> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return null
    const state = await this.loadState()
    const session = state.sessions.find((item) => item.tokenHash === tokenHash && item.expiresAt > now)
    if (!session) return null
    const user = state.users.find((item) => item.id === session.userId && item.enabled)
    return user && session.authVersion === user.authVersion ? { session: { ...session }, user: this.publicUser(user) } : null
  }

  async setUserEnabled(userId: string, enabled: boolean) {
    return this.withMutation(async () => {
      const state = await this.loadState()
      const user = state.users.find((item) => item.id === userId)
      if (!user) return null
      if (user.role === "admin" && !enabled && state.users.filter((item) => item.role === "admin" && item.enabled).length <= 1) {
        throw new Error("At least one enabled administrator is required")
      }
      user.enabled = enabled
      if (!enabled) state.sessions = state.sessions.filter((session) => session.userId !== userId)
      await this.persist(state)
      return this.publicUser(user)
    })
  }

  async setUserPassword(userId: string, password: string) {
    if (password.length < 12) throw new Error("Gateway passwords must be at least 12 characters")
    return this.withMutation(async () => {
      const state = await this.loadState()
      const user = state.users.find((item) => item.id === userId)
      if (!user) return null
      user.passwordHash = await Bun.password.hash(password, { algorithm: "argon2id" })
      user.authVersion += 1
      state.sessions = state.sessions.filter((session) => session.userId !== userId)
      await this.persist(state)
      return this.publicUser(user)
    })
  }

  async setUserConnections(userId: string, connectionIds: string[]) {
    if (new Set(connectionIds).size !== connectionIds.length || connectionIds.some((id) => !/^[a-f0-9]{32}$/.test(id))) {
      throw new Error("Invalid managed connection grants")
    }
    return this.withMutation(async () => {
      const state = await this.loadState()
      const user = state.users.find((item) => item.id === userId)
      if (!user || user.role === "admin") return null
      if (connectionIds.some((id) => !state.connections.some((connection) => connection.id === id))) {
        throw new Error("Managed connection does not exist")
      }
      user.connectionIds = [...connectionIds]
      await this.persist(state)
      return this.publicUser(user)
    })
  }

  async listConnections(): Promise<ManagedConnectionSummary[]> {
    const state = await this.loadState()
    return state.connections.map((connection) => this.publicConnection(connection))
  }

  async getConnectionCredential(id: string): Promise<StoredManagedConnection | null> {
    const state = await this.loadState()
    const connection = state.connections.find((item) => item.id === id && item.enabled)
    return connection ? { ...connection } : null
  }

  async getUserByAccount(accountId: string): Promise<GatewayUser | null> {
    const state = await this.loadState()
    const user = state.users.find((item) => item.role === "user" && item.accountId === accountId && item.enabled)
    return user ? this.publicUser(user) : null
  }

  async createConnection(args: { name: string; provider: ManagedProvider; apiKey: string }) {
    if (!args.name.trim() || args.name.length > 80) throw new Error("Connection name must be 1 to 80 characters")
    if (args.provider !== "codex" && args.provider !== "claude") throw new Error("Unsupported managed provider")
    if (!args.apiKey.trim() || args.apiKey.length > 8192) throw new Error("API key is missing or too long")
    return this.withMutation(async () => {
      const state = await this.loadState()
      const connection: StoredManagedConnection = {
        id: randomBytes(16).toString("hex"),
        name: args.name.trim(),
        provider: args.provider,
        enabled: true,
        apiKey: args.apiKey,
        createdAt: Date.now(),
      }
      state.connections.push(connection)
      await this.persist(state)
      return this.publicConnection(connection)
    })
  }

  async updateConnection(id: string, patch: { name?: string; enabled?: boolean; apiKey?: string }) {
    return this.withMutation(async () => {
      const state = await this.loadState()
      const connection = state.connections.find((item) => item.id === id)
      if (!connection) return null
      if (patch.name !== undefined) {
        if (!patch.name.trim() || patch.name.length > 80) throw new Error("Connection name must be 1 to 80 characters")
        connection.name = patch.name.trim()
      }
      if (patch.enabled !== undefined) connection.enabled = patch.enabled
      if (patch.apiKey !== undefined) {
        if (!patch.apiKey.trim() || patch.apiKey.length > 8192) throw new Error("API key is missing or too long")
        connection.apiKey = patch.apiKey
      }
      await this.persist(state)
      return this.publicConnection(connection)
    })
  }

  async deleteConnection(id: string) {
    return this.withMutation(async () => {
      const state = await this.loadState()
      const originalLength = state.connections.length
      state.connections = state.connections.filter((item) => item.id !== id)
      if (state.connections.length === originalLength) return false
      for (const user of state.users) user.connectionIds = user.connectionIds.filter((connectionId) => connectionId !== id)
      await this.persist(state)
      return true
    })
  }

  async getAssignedConnections(userId: string): Promise<ManagedConnectionSummary[]> {
    const state = await this.loadState()
    const user = state.users.find((item) => item.id === userId && item.enabled)
    if (!user || user.role === "admin") return []
    const connections = new Map(state.connections.filter((connection) => connection.enabled).map((connection) => [connection.id, connection]))
    return user.connectionIds.flatMap((id) => {
      const connection = connections.get(id)
      return connection ? [this.publicConnection(connection)] : []
    })
  }

  async getAssignedConnectionsForAccount(accountId: string) {
    const state = await this.loadState()
    const user = state.users.find((item) => item.role === "user" && item.accountId === accountId && item.enabled)
    if (!user) return []
    const connections = new Map(state.connections.filter((connection) => connection.enabled).map((connection) => [connection.id, connection]))
    return user.connectionIds.flatMap((id) => {
      const connection = connections.get(id)
      return connection ? [{
        ...this.publicConnection(connection),
        apiKey: connection.apiKey,
        provider: connection.provider,
      }] : []
    })
  }

  async revokeSession(token: string) {
    return this.withMutation(async () => {
      const state = await this.loadState()
      const tokenHash = hashSessionToken(token)
      const next = state.sessions.filter((session) => session.tokenHash !== tokenHash)
      if (next.length !== state.sessions.length) {
        state.sessions = next
        await this.persist(state)
      }
    })
  }

  private validateState(state: GatewayState) {
    const usernames = new Set<string>()
    const ids = new Set<string>()
    for (const user of state.users) {
      validateUserInput(user)
      if (!user.id || ids.has(user.id) || usernames.has(user.username) || !user.passwordHash.startsWith("$argon2id$") ||
        typeof user.enabled !== "boolean" || !Number.isSafeInteger(user.authVersion) || user.authVersion < 1 ||
        !Array.isArray(user.connectionIds) || user.connectionIds.some((id) => typeof id !== "string")) {
        throw new Error("Invalid gateway user record")
      }
      ids.add(user.id)
      usernames.add(user.username)
    }
    for (const session of state.sessions) {
      if (!ids.has(session.userId) || !/^[a-f0-9]{64}$/.test(session.tokenHash) || !Number.isSafeInteger(session.authVersion)) {
        throw new Error("Invalid gateway session record")
      }
    }
    const connectionIds = new Set<string>()
    for (const connection of state.connections) {
      if (!/^[a-f0-9]{32}$/.test(connection.id) || connectionIds.has(connection.id) ||
        (connection.provider !== "codex" && connection.provider !== "claude") ||
        typeof connection.enabled !== "boolean" || !connection.name || typeof connection.apiKey !== "string" || !connection.apiKey) {
        throw new Error("Invalid managed connection record")
      }
      connectionIds.add(connection.id)
    }
    if (state.users.some((user) => user.connectionIds.some((id) => !connectionIds.has(id)))) {
      throw new Error("Gateway user references a missing managed connection")
    }
  }

  private publicUser(user: StoredGatewayUser): GatewayUser {
    const { passwordHash: _passwordHash, ...publicUser } = user
    const { createdAt: _createdAt, ...summary } = publicUser
    return summary
  }

  private publicConnection(connection: StoredManagedConnection): ManagedConnectionSummary {
    return {
      id: connection.id,
      name: connection.name,
      provider: connection.provider,
      enabled: connection.enabled,
      shareable: true,
    }
  }

  private async persist(state: GatewayState) {
    const operation = this.writeQueue.then(async () => {
      await this.ensurePrivateDirectory()
      const temp = `${this.statePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
      await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      await chmod(temp, 0o600)
      if (this.owner && typeof process.getuid === "function" && process.getuid() === 0) await chown(temp, this.owner.uid, this.owner.gid)
      await rename(temp, this.statePath)
      await chmod(this.statePath, 0o600)
      this.state = structuredClone(state)
    })
    this.writeQueue = operation.catch(() => {})
    await operation
  }

  private async ensurePrivateDirectory() {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 })
    const info = await lstat(this.stateDirectory)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Gateway state directory must be a private directory")
    await chmod(this.stateDirectory, 0o700)
    if (this.owner && typeof process.getuid === "function" && process.getuid() === 0 &&
      (info.uid !== this.owner.uid || info.gid !== this.owner.gid)) {
      await chown(this.stateDirectory, this.owner.uid, this.owner.gid)
    }
  }

  private async withMutation<T>(callback: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue
    let release!: () => void
    this.mutationQueue = new Promise<void>((resolve) => { release = resolve })
    await previous
    try {
      return await callback()
    } finally {
      release()
    }
  }
}
