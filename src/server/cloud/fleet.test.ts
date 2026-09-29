import { describe, expect, test } from "bun:test"
import type { CloudIdentity } from "./identity"
import { createFleetCache } from "./fleet"

const IDENTITY = {
  controlUrl: "http://cp/api/cloud",
  machineToken: "machine-token",
  subdomain: "jake-mbp",
} as CloudIdentity

const MACHINE = {
  subdomain: "jake-studio",
  name: "Studio",
  appOrigin: "https://jake-studio.kanna.sh",
  online: true,
  lastSeenAt: 1,
}

describe("createFleetCache", () => {
  test("asks the control plane with the machine token, then caches", async () => {
    const calls: Array<{ url: string; auth: string | null }> = []
    let clock = 0
    const fleet = createFleetCache({
      now: () => clock,
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get("authorization") })
        return Response.json({ self: "jake-mbp", machines: [MACHINE] })
      }) as unknown as typeof fetch,
    })

    expect(await fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [MACHINE] })
    await fleet.get(IDENTITY)
    expect(calls).toEqual([{ url: "http://cp/api/cloud/fleet", auth: "Bearer machine-token" }])

    clock = 20_000
    await fleet.get(IDENTITY)
    expect(calls).toHaveLength(2)
  })

  test("unpaired is empty; a failing control plane still names this machine", async () => {
    const fleet = createFleetCache({
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    })
    expect(await fleet.get(null)).toEqual({ self: null, machines: [] })
    expect(await fleet.get(IDENTITY)).toEqual({ self: "jake-mbp", machines: [] })
  })
})
