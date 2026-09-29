import { session } from "electron"
import fs from "node:fs"
import path from "node:path"
import { agent } from "./server-agent"
import { dataRoot } from "./server-mode"

/**
 * The Kanna Cloud machines of the account this Mac is paired to, for the
 * Fleet menu and the sidebar's picker.
 *
 * The local server has the list: it asks kanna.sh with this Mac's own machine
 * credentials (GET /api/cloud/fleet, src/server/cloud/fleet.ts), so listing
 * needs no sign-in, and `self` names this Mac. Showing this Mac means the
 * local server, never its kanna.sh address, which would send its own traffic
 * out through Cloudflare and back. Any other machine loads from kanna.sh,
 * which takes a session in the window (app-auth.ts).
 */
export interface Machine {
  subdomain: string
  name: string
  appOrigin: string
  online: boolean
  lastSeenAt?: number | null
  kind?: string | null
}

/** kanna.sh's session cookie (kanna-site src/worker/cloud/cookies.ts). */
export const SESSION_COOKIE = "kanna_cloud_session"

class Fleet {
  list: Machine[] = []
  /** This Mac's subdomain; null while it isn't on Kanna Cloud. */
  thisSubdomain: string | null = null
  onChange: (() => void) | null = null
  private timer: NodeJS.Timeout | null = null

  /** The control plane this Mac paired with (cloud.json's controlUrl), else kanna.sh. */
  get site() {
    const root = dataRoot(agent.mode)
    try {
      const pairing = JSON.parse(fs.readFileSync(path.join(root ?? "", "cloud.json"), "utf8")) as { controlUrl?: string }
      if (pairing.controlUrl) return new URL(pairing.controlUrl).origin
    } catch {}
    return "https://kanna.sh"
  }

  machineForHost(host: string) {
    return this.list.find((machine) => {
      try {
        return new URL(machine.appOrigin).hostname.toLowerCase() === host.toLowerCase()
      } catch {
        return false
      }
    })
  }

  /** Whether the window has a kanna.sh session to open other machines with. */
  async hasSession() {
    const host = new URL(this.site).hostname.toLowerCase()
    const cookies = await session.defaultSession.cookies.get({ name: SESSION_COOKIE })
    const now = Date.now() / 1000
    return cookies.some(
      (cookie) => (cookie.domain ?? "").replace(/^\./, "").toLowerCase() === host && (cookie.expirationDate ?? Infinity) > now
    )
  }

  /** Keeps the list fresh while the app runs: machines come and go online. */
  start() {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.refresh(), 60_000)
    void this.refresh()
  }

  async refresh() {
    const server = agent.serverURL
    if (!server) return
    try {
      const response = await fetch(new URL("/api/cloud/fleet", server), { signal: AbortSignal.timeout(10_000) })
      if (response.status !== 200) return
      // CloudLocalFleetResponse in src/shared/cloud-api.ts.
      const decoded = (await response.json()) as { self?: string | null; machines: Machine[] }
      const machines = [...decoded.machines].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
      const self = decoded.self ?? null
      if (JSON.stringify(machines) !== JSON.stringify(this.list) || self !== this.thisSubdomain) {
        this.list = machines
        this.thisSubdomain = self
        this.onChange?.()
      }
    } catch {}
  }
}

export const fleet = new Fleet()
