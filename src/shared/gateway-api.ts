import type { AuthLoginFlowState } from "./types"

export type GatewayRole = "admin" | "user"
export type ManagedProvider = "codex" | "claude"

export interface GatewayUserSummary {
  id: string
  username: string
  role: GatewayRole
  accountId?: string
  enabled: boolean
  connectionIds: string[]
}

export interface ManagedConnectionSummary {
  id: string
  name: string
  provider: ManagedProvider
  enabled: boolean
  shareable: true
}

export interface AdminProviderAuthStatus {
  id: ManagedProvider
  installed: boolean
  authStatus: string
  /** Native admin CLI OAuth is never made available to regular workspace users. */
  shareable: false
  flow: AuthLoginFlowState
}

export interface GatewayAuthStatusResponse {
  authMode: "bearer"
  usernameRequired: true
  enabled: true
  authenticated: boolean
  user: GatewayUserSummary | null
  expiresAt?: number
}

export interface GatewayLoginRequest {
  username: string
  password: string
}

export interface GatewayLoginResponse {
  token: string
  expiresAt: number
  user: GatewayUserSummary
}

export interface GatewayWebSocketTicketResponse {
  ticket: string
}

export interface AdminGatewayStateResponse {
  users: GatewayUserSummary[]
  connections: ManagedConnectionSummary[]
  providerAuth: AdminProviderAuthStatus[]
}

export interface PatchGatewayUserRequest {
  enabled?: boolean
  password?: string
}

export interface CreateManagedConnectionRequest {
  name: string
  provider: ManagedProvider
  apiKey: string
}

export interface PatchManagedConnectionRequest {
  name?: string
  enabled?: boolean
  apiKey?: string
}

export interface GrantManagedConnectionsRequest {
  connectionIds: string[]
}

export interface GatewayProviderAccessResponse {
  assigned: ManagedConnectionSummary[]
  selfFirst: true
}

export interface InternalGatewayProviderAccessResponse {
  assigned: Array<ManagedConnectionSummary & { baseUrl: string }>
  selfFirst: true
}
