import { beforeEach, describe, expect, test } from "bun:test"
import type { CloudMachineSummary } from "../../shared/cloud-api"
import { findCurrentMachine, useConnectionStore } from "./connectionStore"

const MACHINES: CloudMachineSummary[] = [
  {
    subdomain: "jakemor-mbp",
    name: "Jake's MBP",
    appOrigin: "https://jakemor-mbp.kanna.sh",
    online: true,
    lastSeenAt: 1,
  },
  {
    subdomain: "jakemor-studio",
    name: "Studio",
    appOrigin: "https://jakemor-studio.kanna.sh",
    online: false,
    lastSeenAt: null,
  },
]

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(() => {
  useConnectionStore.setState({
    mode: "unknown",
    machines: [],
    thisMachine: null,
    showingMachine: null,
    fromMacApp: false,
  })
})

describe("connectionStore.setMacAppFleet", () => {
  test("the app's list wins over the page's own detection", async () => {
    useConnectionStore.getState().setMacAppFleet({ machines: MACHINES, thisMachine: "jakemor-mbp", showing: "jakemor-studio" })
    const fetchImpl = (async () => jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    const state = useConnectionStore.getState()
    expect(state.mode).toBe("cloud")
    expect(state.machines).toEqual(MACHINES)
    expect(state.thisMachine).toBe("jakemor-mbp")
    expect(state.showingMachine).toBe("jakemor-studio")
  })

  test("null after a list (signed out) goes back to detection", () => {
    useConnectionStore.getState().setMacAppFleet({ machines: MACHINES })
    useConnectionStore.getState().setMacAppFleet(null)
    const state = useConnectionStore.getState()
    expect(state.mode).toBe("unknown")
    expect(state.fromMacApp).toBe(false)
    expect(state.thisMachine).toBeNull()
  })

  test("null before any list leaves detection alone", () => {
    useConnectionStore.setState({ mode: "local" })
    useConnectionStore.getState().setMacAppFleet(null)
    expect(useConnectionStore.getState().mode).toBe("local")
  })
})

describe("connectionStore.load", () => {
  test("JSON 200 from /__cloud/machines → cloud mode with machines", async () => {
    const fetchImpl = (async () => jsonResponse({ machines: MACHINES })) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    expect(useConnectionStore.getState().mode).toBe("cloud")
    expect(useConnectionStore.getState().machines).toEqual(MACHINES)
  })

  test("on localhost, a paired machine's own Fleet → cloud mode naming itself", async () => {
    const fetchImpl = (async (url: string) =>
      url === "/api/cloud/fleet"
        ? jsonResponse({ self: "jakemor-mbp", machines: MACHINES })
        : jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    const state = useConnectionStore.getState()
    expect(state.mode).toBe("cloud")
    expect(state.machines).toEqual(MACHINES)
    expect(state.thisMachine).toBe("jakemor-mbp")
    expect(state.showingMachine).toBe("jakemor-mbp")
  })

  test("an unpaired machine's empty Fleet → local mode", async () => {
    const fetchImpl = (async (url: string) =>
      url === "/api/cloud/fleet"
        ? jsonResponse({ self: null, machines: [] })
        : jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    expect(useConnectionStore.getState().mode).toBe("local")
  })

  test("machine's explicit 404 → local mode", async () => {
    const fetchImpl = (async () => jsonResponse({ error: "Not found" }, 404)) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    expect(useConnectionStore.getState().mode).toBe("local")
  })

  test("HTML 200 (stale server SPA fallback) → local mode", async () => {
    const fetchImpl = (async () =>
      new Response("<!doctype html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    expect(useConnectionStore.getState().mode).toBe("local")
  })

  test("network failure → local mode", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    await useConnectionStore.getState().load(fetchImpl)
    expect(useConnectionStore.getState().mode).toBe("local")
  })
})

describe("findCurrentMachine", () => {
  test("matches by hostname", () => {
    expect(findCurrentMachine(MACHINES, "jakemor-mbp.kanna.sh")?.subdomain).toBe("jakemor-mbp")
    expect(findCurrentMachine(MACHINES, "JAKEMOR-STUDIO.kanna.sh:443")?.subdomain).toBe("jakemor-studio")
    expect(findCurrentMachine(MACHINES, "localhost:3210")).toBeNull()
  })
})
