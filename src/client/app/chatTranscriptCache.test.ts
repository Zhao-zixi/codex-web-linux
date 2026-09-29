import { expect, test } from "bun:test"
import { createTranscriptCacheWriter, deleteCachedWindow, readMemoryCachedWindow } from "./chatTranscriptCache"
import type { TranscriptEntry } from "../../shared/types"

test("a chat switch makes a bounded memory window available before disk writes", async () => {
  const id = crypto.randomUUID()
  try {
    const writer = createTranscriptCacheWriter()
    const messages: TranscriptEntry[] = Array.from({ length: 200 }, (_, i) => ({ _id: `${i}`, kind: "assistant_text", createdAt: i, text: "test" }))
    writer.schedule(id, { messages, startIndex: 100 }, true)
    writer.flush()
    const window = readMemoryCachedWindow(id)
    expect(window?.entries).toHaveLength(50)
    expect(window?.startIndex).toBe(250)
    expect(window?.entries.at(-1)?._id).toBe("199")
  } finally { await deleteCachedWindow(id) }
})

test("memory follows a streaming chat on every change, before anything settles", async () => {
  const id = crypto.randomUUID()
  try {
    const writer = createTranscriptCacheWriter()
    const first: TranscriptEntry[] = [{ _id: "0", kind: "assistant_text", createdAt: 0, text: "a" }]
    writer.schedule(id, { messages: first, startIndex: 0 }, true)
    expect(readMemoryCachedWindow(id)?.entries).toBe(first)

    const second = [...first, { _id: "1", kind: "assistant_text", createdAt: 1, text: "b" } as TranscriptEntry]
    writer.schedule(id, { messages: second, startIndex: 0 }, true)
    // The live array itself, not a copy: nothing is encoded mid-stream.
    expect(readMemoryCachedWindow(id)?.entries).toBe(second)
  } finally { await deleteCachedWindow(id) }
})
