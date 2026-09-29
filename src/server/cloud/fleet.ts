/**
 * The Fleet (the account's machines) for this machine's own UI:
 * `GET /api/cloud/fleet` on localhost, for the sidebar's picker and Kanna for
 * Mac's Fleet menu. Neither has a kanna.sh session there, so the machine asks
 * the control plane with its own credentials (`GET {controlUrl}/fleet`).
 *
 * Kept outside CloudApiClient on purpose: it's the one call a UI drives, so
 * it caches, and every fake client in the tests stays as it is.
 */

import type { CloudFleetResponse, CloudLocalFleetResponse } from "../../shared/cloud-api"
import type { CloudIdentity } from "./identity"

/** The picker and the Mac app each poll; kanna.sh sees one call per window. */
const FLEET_CACHE_MS = 15_000

export interface FleetCache {
  get(identity: CloudIdentity | null): Promise<CloudLocalFleetResponse>
}

export function createFleetCache(deps: { fetchImpl?: typeof fetch; now?: () => number } = {}): FleetCache {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  let cached: { token: string; at: number; value: CloudLocalFleetResponse } | null = null
  let inflight: Promise<CloudLocalFleetResponse> | null = null

  async function load(identity: CloudIdentity): Promise<CloudLocalFleetResponse> {
    // This machine alone, if kanna.sh doesn't answer: the picker still has
    // something true to show.
    const fallback: CloudLocalFleetResponse = { self: identity.subdomain, machines: [] }
    try {
      const response = await fetchImpl(`${identity.controlUrl}/fleet`, {
        headers: { Authorization: `Bearer ${identity.machineToken}`, Accept: "application/json" },
      })
      if (!response.ok) return fallback
      const payload = await response.json() as CloudFleetResponse
      if (!Array.isArray(payload.machines)) return fallback
      return { self: payload.self ?? identity.subdomain, machines: payload.machines }
    } catch {
      return fallback
    }
  }

  return {
    async get(identity) {
      if (!identity) return { self: null, machines: [] }
      if (cached && cached.token === identity.machineToken && now() - cached.at < FLEET_CACHE_MS) {
        return cached.value
      }
      inflight ??= load(identity).then((value) => {
        cached = { token: identity.machineToken, at: now(), value }
        return value
      }).finally(() => {
        inflight = null
      })
      return inflight
    },
  }
}
