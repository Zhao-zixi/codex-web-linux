import { create } from "zustand"
import {
  CLOUD_BROWSER_PATH_PREFIX,
  CLOUD_FLEET_PATH,
  type CloudLocalFleetResponse,
  type CloudMachineSummary,
  type CloudMachinesResponse,
} from "../../shared/cloud-api"

/**
 * Cloud-mode detection + the paired-machine list for the sidebar switcher.
 *
 * Feature detection: `GET /__cloud/machines` is answered by the kanna.sh
 * proxy on machine subdomains (never forwarded); the machine's own server
 * explicitly 404s the prefix, so a JSON 200 means "cloud", anything else
 * means "local". Not persisted — the answer is a property of the origin.
 *
 * On the machine's own address (localhost) there's no kanna.sh session, so
 * a paired machine lists its Fleet itself, with its machine credentials
 * (`GET /api/cloud/fleet`, src/server/cloud/fleet.ts), and names itself.
 *
 * Kanna for Mac also knows which machine the window shows, and shows this
 * Mac at its local address. So it hands the page the list
 * (`pushFleet` in macos/src/window.ts), and while it does, that list
 * wins, on localhost or on a machine subdomain.
 */

export type ConnectionMode = "unknown" | "local" | "cloud"

/** What Kanna for Mac pushes: null while signed out or still loading. */
export interface MacAppFleet {
  machines: CloudMachineSummary[]
  /** This Mac's subdomain; absent when it isn't on Kanna Cloud. */
  thisMachine?: string
  /** The machine the window shows; absent for an unpaired this Mac. */
  showing?: string
}

interface ConnectionState {
  mode: ConnectionMode
  machines: CloudMachineSummary[]
  /** The machine serving this page, when it knows (localhost, Kanna for Mac). */
  thisMachine: string | null
  showingMachine: string | null
  fromMacApp: boolean
  /** Detect mode + load the machine list. Safe to call repeatedly. */
  load: (fetchImpl?: typeof fetch) => Promise<void>
  setMacAppFleet: (payload: MacAppFleet | null) => void
}

export function findCurrentMachine(
  machines: CloudMachineSummary[],
  host: string = typeof window !== "undefined" ? window.location.host : "",
): CloudMachineSummary | null {
  const hostname = host.split(":")[0].toLowerCase()
  return machines.find((machine) => {
    try {
      return new URL(machine.appOrigin).hostname.toLowerCase() === hostname
    } catch {
      return false
    }
  }) ?? null
}

async function loadLocalFleet(fetchImpl: typeof fetch): Promise<CloudLocalFleetResponse | null> {
  try {
    const response = await fetchImpl(CLOUD_FLEET_PATH, { headers: { Accept: "application/json" } })
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return null
    const payload = await response.json() as CloudLocalFleetResponse
    return Array.isArray(payload.machines) ? payload : null
  } catch {
    return null
  }
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  mode: "unknown",
  machines: [],
  thisMachine: null,
  showingMachine: null,
  fromMacApp: false,

  load: async (fetchImpl = fetch) => {
    try {
      const response = await fetchImpl(`${CLOUD_BROWSER_PATH_PREFIX}/machines`, {
        headers: { Accept: "application/json" },
      })
      if (response.ok && (response.headers.get("content-type") ?? "").includes("application/json")) {
        const payload = await response.json() as CloudMachinesResponse
        if (Array.isArray(payload.machines)) {
          if (!get().fromMacApp) set({ mode: "cloud", machines: payload.machines })
          return
        }
      }
    } catch {
      // Unreachable → treat as local.
    }
    const fleet = await loadLocalFleet(fetchImpl)
    if (get().fromMacApp) return
    if (fleet && fleet.self && fleet.machines.length > 0) {
      set({ mode: "cloud", machines: fleet.machines, thisMachine: fleet.self, showingMachine: fleet.self })
      return
    }
    set({ mode: "local", machines: [] })
  },

  setMacAppFleet: (payload) => {
    if (payload && Array.isArray(payload.machines)) {
      set({
        mode: "cloud",
        machines: payload.machines,
        thisMachine: payload.thisMachine ?? null,
        showingMachine: payload.showing ?? null,
        fromMacApp: true,
      })
      return
    }
    // Signed out: back to the page's own detection (MachineSwitcher reloads
    // on "unknown").
    if (get().fromMacApp) {
      set({ mode: "unknown", machines: [], thisMachine: null, showingMachine: null, fromMacApp: false })
    }
  },
}))

declare global {
  interface Window {
    __kannaFleet?: MacAppFleet | null
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const apply = (payload: MacAppFleet | null | undefined) => {
    if (payload !== undefined) useConnectionStore.getState().setMacAppFleet(payload)
  }
  apply(window.__kannaFleet)
  window.addEventListener("kanna:fleet", (event) => {
    apply((event as CustomEvent<MacAppFleet | null>).detail)
  })
}
