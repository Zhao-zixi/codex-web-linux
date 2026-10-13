import { describe, expect, test } from "bun:test"
import { createNativeProviderTokenSingleflight } from "./gateway-provider-control"

describe("admin native token request boundary", () => {
  test("coalesces identical requests before they enter the provider lock", async () => {
    const singleflight = createNativeProviderTokenSingleflight<string>()
    let calls = 0
    const action = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return "short-access"
    }
    const [first, second] = await Promise.all([
      singleflight("codex", {}, action),
      singleflight("codex", {}, action),
    ])
    expect(calls).toBe(1)
    expect(first).toBe("short-access")
    expect(second).toBe(first)
  })

  test("does not coalesce a forced refresh or a different pinned account", async () => {
    const singleflight = createNativeProviderTokenSingleflight<string>()
    const calls: string[] = []
    const action = (label: string) => async () => {
      calls.push(label)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return label
    }
    const values = await Promise.all([
      singleflight("codex", { previousAccountId: "acct-1" }, action("normal")),
      singleflight("codex", { forceRefresh: true, previousAccountId: "acct-1" }, action("refresh")),
      singleflight("codex", { previousAccountId: "acct-2" }, action("other-account")),
    ])
    expect(calls).toHaveLength(3)
    expect(values).toEqual(["normal", "refresh", "other-account"])
  })
})
