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
  kind: "api_key" | "native"
  enabled: boolean
  shareable: boolean
  connected?: boolean
}

export interface AdminProviderAuthStatus {
  id: ManagedProvider
  installed: boolean
  authStatus: string
  /** Connection created for this provider's signed-in admin CLI profile, if any. */
  connectionId?: string
  shareable: boolean
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
  kind?: "api_key"
  apiKey?: string
}

export interface CreateNativeManagedConnectionRequest {
  name: string
  provider: ManagedProvider
  kind: "native"
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
  assigned: Array<ManagedConnectionSummary & { baseUrl?: string }>
  selfFirst: true
}

export interface NativeProviderTokenRequest {
  forceRefresh?: boolean
  previousAccountId?: string
}

export type NativeProviderTokenData =
  | { provider: "codex"; expiresAt: number; accessToken: string; chatgptAccountId: string; chatgptPlanType?: string }
  | { provider: "claude"; expiresAt: number; accessToken: string }

export type NativeProviderTokenResponse = NativeProviderTokenData & { connectionId: string }
