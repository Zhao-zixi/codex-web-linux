import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { fetchVisualizationHeights, recordVisualizationHeight, rememberedVisualizationHeights, rememberVisualizationHeights } from "./visualization-heights"

const URL_A = "/api/chats/chat-1/media/visualization-abc.html"

describe("the heights a browser has measured visualizations at", () => {
  const original = { localStorage: globalThis.localStorage, fetch: globalThis.fetch }
  let stored: Map<string, string>
  let requests: Array<{ url: string; method: string; body: unknown }>

  beforeEach(() => {
    stored = new Map()
    requests = []
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    } })
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
      return Response.json({ heights: [[400, 610]] })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original.localStorage })
    globalThis.fetch = original.fetch
  })

  test("a settled height is kept here and reported to the server, once", () => {
    const known = recordVisualizationHeight(URL_A, [], 728, 412)
    expect(known).toEqual([[736, 412]])
    expect(rememberedVisualizationHeights(URL_A)).toEqual([[736, 412]])
    expect(requests).toEqual([{ url: `${URL_A}/heights`, method: "PUT", body: { width: 736, height: 412 } }])
    // The same height at the same width again is nothing new: no write, no request.
    expect(recordVisualizationHeight(URL_A, known, 730, 412)).toBe(known)
    expect(requests).toHaveLength(1)
    // Another width is another measurement.
    expect(recordVisualizationHeight(URL_A, known, 393, 610)).toEqual([[400, 610], [736, 412]])
    expect(requests).toHaveLength(2)
  })

  test("an exported chat's visualization is remembered here and reported nowhere", () => {
    recordVisualizationHeight("./attachments/visualization-abc.html", [], 728, 412)
    expect(rememberedVisualizationHeights("./attachments/visualization-abc.html")).toEqual([[736, 412]])
    expect(requests).toEqual([])
  })

  test("what the server has is read from beside the document", async () => {
    expect(await fetchVisualizationHeights(URL_A)).toEqual([[400, 610]])
    expect(requests).toEqual([{ url: `${URL_A}/heights`, method: "GET", body: undefined }])
    expect(await fetchVisualizationHeights("./attachments/visualization-abc.html")).toEqual([])
    globalThis.fetch = (async () => { throw new Error("offline") }) as unknown as typeof fetch
    expect(await fetchVisualizationHeights(URL_A)).toEqual([])
  })

  test("the oldest documents are forgotten, and storage that fails is no memory at all", () => {
    for (let index = 0; index < 205; index += 1) rememberVisualizationHeights(`/api/chats/c/media/visualization-${index}.html`, [[736, 400]])
    expect(rememberedVisualizationHeights("/api/chats/c/media/visualization-0.html")).toEqual([])
    expect(rememberedVisualizationHeights("/api/chats/c/media/visualization-204.html")).toEqual([[736, 400]])
    expect(Object.keys(JSON.parse(stored.get("kanna-visualization-heights")!))).toHaveLength(200)
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => { throw new Error("denied") }, setItem: () => { throw new Error("denied") } } })
    expect(rememberedVisualizationHeights(URL_A)).toEqual([])
    expect(() => rememberVisualizationHeights(URL_A, [[736, 400]])).not.toThrow()
  })
})
