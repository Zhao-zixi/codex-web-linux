import { create } from "zustand"
import {
  CLOUD_BROWSER_PATH_PREFIX,
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
 * Kanna for Mac knows more than the page: it's signed in to kanna.sh
 * natively and knows which machine is the Mac it runs on, which it shows at
 * its local address. So it hands the page the list itself
 * (`MainWindowController.pushMachines` in macos/), and while it does, that
 * list wins over /__cloud/machines, on localhost or on a machine subdomain.
 */

export type ConnectionMode = "unknown" | "local" | "cloud"

/** What Kanna for Mac pushes: null while signed out or still loading. */
export interface MacAppMachines {
  machines: CloudMachineSummary[]
  /** This Mac's subdomain; absent when it isn't on Kanna Cloud. */
  thisMachine?: string
  /** The machine the window shows; absent for an unpaired this Mac. */
  showing?: string
}

interface ConnectionState {
  mode: ConnectionMode
  machines: CloudMachineSummary[]
  /** From Kanna for Mac only; null in a browser. */
  thisMachine: string | null
  showingMachine: string | null
  fromMacApp: boolean
  /** Detect mode + load the machine list. Safe to call repeatedly. */
  load: (fetchImpl?: typeof fetch) => Promise<void>
  setMacAppMachines: (payload: MacAppMachines | null) => void
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
    if (!get().fromMacApp) set({ mode: "local", machines: [] })
  },

  setMacAppMachines: (payload) => {
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
    __kannaMachines?: MacAppMachines | null
  }
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  const apply = (payload: MacAppMachines | null | undefined) => {
    if (payload !== undefined) useConnectionStore.getState().setMacAppMachines(payload)
  }
  apply(window.__kannaMachines)
  window.addEventListener("kanna:machines", (event) => {
    apply((event as CustomEvent<MacAppMachines | null>).detail)
  })
}
