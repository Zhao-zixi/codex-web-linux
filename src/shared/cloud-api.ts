/**
 * Kanna Cloud pairing contract (v2 — named tunnels).
 *
 * This file is the wire contract between the open-source machine side (this
 * repo) and the hosted control plane / proxy (kanna-site, private). It is
 * mirrored verbatim as `kanna-site/src/shared/cloud-api.ts`.
 *
 * APPEND-ONLY: never remove or rename a field or constant; add optional
 * fields only. Machines in the wild update on their own schedule and must
 * keep working against the deployed control plane (and vice versa).
 *
 * Transport model: each machine gets a named Cloudflare tunnel owned by the
 * kanna.sh account, with a permanent hostname (`tunnelHost`, e.g.
 * `tun-<machineId>.kanna.sh`) created at machine-creation time. The machine
 * runs the connector with `tunnelToken` and reports liveness via heartbeats;
 * there is no per-boot URL registration because the hostname never changes.
 *
 * No Bun/node imports here — shared code is imported by both the server and
 * the browser client (and by the kanna-site Worker via the mirror).
 */

/** Default control-plane base URL (the hosted kanna.sh API). */
export const DEFAULT_CLOUD_CONTROL_URL = "https://kanna.sh/api/cloud"

/** Env var that overrides the control-plane base URL (self-hosters, tests). */
export const CLOUD_CONTROL_URL_ENV_VAR = "KANNA_CLOUD_CONTROL_URL"

/**
 * Header the proxy injects on every request it forwards to the machine's
 * tunnel. Value is the machine's `proxySecret`. The proxy strips any inbound
 * copy so the machine can trust it: a request carrying the correct value is
 * guaranteed to have come through the gated proxy.
 */
export const PROXY_AUTH_HEADER = "x-kanna-proxy-auth"

/**
 * Reserved path prefix answered by the proxy itself on machine subdomains —
 * requests under it are never forwarded to the machine. The machine server
 * explicitly 404s this prefix so the client can feature-detect cloud mode
 * (the SPA fallback would otherwise answer with index.html).
 */
export const CLOUD_BROWSER_PATH_PREFIX = "/__cloud"

/**
 * Machine-served endpoint the client fetches before every WebSocket connect.
 * Always present: proxied requests get the machine's stable tunnel WS URL +
 * a short-lived connect token; local requests get `wsUrl: null` (use
 * same-origin `/ws`).
 */
export const CLOUD_WS_ENDPOINT_PATH = "/api/cloud/ws-endpoint"

/**
 * Machine-served, local requests only: `POST` starts (or reuses) a
 * device-code claim session and `GET` reports its state. Backs the sidebar's
 * one-click "Use this machine from anywhere" flow.
 */
export const CLOUD_PAIR_SESSION_PATH = "/api/cloud/pair-session"

// ---------------------------------------------------------------------------
// Machine → control plane (`{controlUrl}/…`)
// ---------------------------------------------------------------------------

/** `POST {controlUrl}/pair` — one-time exchange of a pairing code. */
export interface CloudPairRequest {
  pairingCode: string
  /** Machine display name, used to label the machine in the dashboard. */
  machineName?: string
}

/**
 * Pairing codes are single-use with a short TTL; the control plane responds
 * 404/410 for unknown/expired codes.
 */
export interface CloudPairResponse {
  /** Durable bearer credential for the machine-facing endpoints below. */
  machineToken: string
  /** Shared secret the proxy sends in PROXY_AUTH_HEADER on forwarded requests. */
  proxySecret: string
  /** The claimed subdomain, e.g. "jakemor-mbp". */
  subdomain: string
  /** Public app origin for this machine, e.g. "https://jakemor-mbp.kanna.sh". */
  appOrigin: string
  /** Connector credential for this machine's named Cloudflare tunnel (scoped to it alone). */
  tunnelToken: string
  /** Permanent tunnel hostname, e.g. "tun-<machineId>.kanna.sh". */
  tunnelHost: string
}

// ---------------------------------------------------------------------------
// Device-code pairing (machine-initiated, the one-click flow)
//
// The machine asks for a claim code, shows `claimUrl` (link + QR), and polls
// with `deviceToken` until a signed-in browser claims it at kanna.sh/machine.
// Inverts the older dashboard-first flow: no terminal step, and the browser
// half can happen on a phone.
// ---------------------------------------------------------------------------

/** Browser path on the site that redeems a claim code (`?pair=<code>`). */
export const CLOUD_CLAIM_PATH = "/machine"

/** Query parameter carrying the claim code on CLOUD_CLAIM_PATH. */
export const CLOUD_CLAIM_CODE_PARAM = "pair"

/** `POST {controlUrl}/device-code` — unauthenticated; starts a claim session. */
export interface CloudDeviceCodeRequest {
  /** Suggested display name (this machine's hostname) to prefill the form. */
  machineName?: string
}

export interface CloudDeviceCodeResponse {
  /** The code embedded in `claimUrl`. Single-use, short TTL. */
  code: string
  /**
   * Secret the machine polls with. Separate from `code` on purpose: the code
   * travels through a QR/link and must not be enough to collect credentials.
   */
  deviceToken: string
  /** Full URL to open in any browser, e.g. "https://kanna.sh/machine?pair=…". */
  claimUrl: string
  /** Unix ms. After this the code is gone and the machine asks for a new one. */
  expiresAt: number
  /** Suggested polling cadence. */
  pollIntervalMs: number
}

/**
 * `POST {controlUrl}/device-code/poll` with `Authorization: Bearer
 * <deviceToken>`. 404 means the session is gone (expired or already
 * redeemed) — treat like "expired".
 */
export interface CloudDeviceCodePollResponse {
  status: "pending" | "claimed"
  /** Present when status is "claimed"; identical to the /pair response. */
  pairing?: CloudPairResponse
}

/**
 * `POST {controlUrl}/heartbeat` with `Authorization: Bearer <machineToken>` —
 * sent when the connector comes up and periodically (~2 min) so the control
 * plane can tell online from dead. Carries the local service URL the
 * connector is fronting; the control plane re-syncs the tunnel's remote
 * ingress when it changes (e.g. the port shifted). 401 = revoked.
 */
export interface CloudHeartbeatRequest {
  /** Local origin the connector serves, e.g. "http://localhost:3210". */
  localUrl: string
}

export interface CloudHeartbeatResponse {
  ok: true
}

/**
 * `POST {controlUrl}/offline` with bearer token — best-effort graceful
 * shutdown signal: the dashboard and proxy show offline immediately instead
 * of waiting out the heartbeat window.
 */
export interface CloudMarkOfflineResponse {
  ok: true
}

/** `DELETE {controlUrl}/machine` with bearer token — unlink this machine. */
export interface CloudMachineRemoveResponse {
  ok: true
}

// ---------------------------------------------------------------------------
// Machine-served (consumed by the client bundle the machine serves)
// ---------------------------------------------------------------------------

/** `GET /api/cloud/ws-endpoint` response. */
export interface CloudWsEndpointResponse {
  /**
   * Direct WebSocket URL (`wss://<tunnelHost>/ws`) when the request arrived
   * through the proxy; null for local requests (client connects same-origin).
   */
  wsUrl: string | null
  /** Short-lived token to append as `?token=`; present when wsUrl is set. */
  connectToken?: string
  expiresInMs?: number
}

// ---------------------------------------------------------------------------
// Proxy-answered browser API (implemented by kanna-site, typed here so the
// OSS client can consume it; never reaches the machine)
// ---------------------------------------------------------------------------

export interface CloudMachineSummary {
  subdomain: string
  name: string
  /** e.g. "https://jakemor-mbp.kanna.sh" */
  appOrigin: string
  online: boolean
  /** Unix ms of the last heartbeat, null if never seen / gracefully offline. */
  lastSeenAt: number | null
  /**
   * "local" — user hardware behind a named tunnel; "e2b" — a cloud dev-box
   * sandbox that auto-pauses when idle and wakes on traffic. Absent from
   * responses that predate dev-boxes → treat as "local".
   */
  kind?: "local" | "e2b"
}

/** `GET /__cloud/machines` — the signed-in account's machines. */
export interface CloudMachinesResponse {
  machines: CloudMachineSummary[]
}

// ---------------------------------------------------------------------------
// Fleet: the account's machines, for a machine's own UI
// ---------------------------------------------------------------------------

/**
 * `GET {controlUrl}/fleet` with `Authorization: Bearer <machineToken>` — the
 * machines of the account this machine is paired to, itself included. A
 * machine's UI on localhost has no kanna.sh session, so the machine asks with
 * its own credentials. 401 = revoked.
 */
export interface CloudFleetResponse {
  /** This machine's subdomain. */
  self: string
  machines: CloudMachineSummary[]
}

/**
 * Machine-served `GET` path for the same list, fetched by the machine with
 * its credentials. `self` is null and `machines` empty while unpaired.
 */
export const CLOUD_FLEET_PATH = "/api/cloud/fleet"

export interface CloudLocalFleetResponse {
  self: string | null
  machines: CloudMachineSummary[]
}
