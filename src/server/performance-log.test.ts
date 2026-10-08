import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PerformanceLog } from "./performance-log"

test("diagnostics retain bounded summaries and remove old files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-test-"))
  try {
    const log = new PerformanceLog(directory)
    await mkdir(log.directory)
    await writeFile(path.join(log.directory, "performance-2000-01-01.jsonl"), "old")
    await writeFile(path.join(log.directory, "keep.txt"), "keep")
    log.record("transcript_async_load_ms", 3)
    log.record("transcript_async_load_ms", 7)
    log.mergeClientSummary({ chat_display_ms: { count: 2, total: 60, max: 40 }, messageText: "must not appear" })
    await log.flush()
    const files = await readdir(log.directory)
    expect(files).not.toContain("performance-2000-01-01.jsonl")
    expect(files).toContain("keep.txt")
    const text = await readFile(path.join(log.directory, files.find(name => name.endsWith(".jsonl"))!), "utf8")
    const row = JSON.parse(text)
    expect(row.metrics.transcript_async_load_ms).toEqual({ count: 2, total: 10, max: 7 })
    expect(row.metrics.client_chat_display_ms).toEqual({ count: 2, total: 60, max: 40 })
    expect(text).not.toContain("must not appear")
    expect(row.memory.rss).toBeGreaterThan(0)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("diagnostics stop writing at the daily byte limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-limit-"))
  try {
    const log = new PerformanceLog(directory, 1)
    await log.flush()
    expect(await readdir(log.directory)).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
