import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PerformanceLog } from "./performance-log"

const diagnosticsEnabled = process.env.KANNA_CI_TEST_DIAG === "1"

function diag(label: string) {
  if (diagnosticsEnabled) console.error(`[ci-diag performance-log] ${label}`)
}

test("diagnostics retain bounded summaries and remove old files", async () => {
  diag("test1 mkdtemp start")
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-test-"))
  diag("test1 mkdtemp done")
  try {
    const log = new PerformanceLog(directory)
    diag("test1 mkdir start")
    await mkdir(log.directory)
    diag("test1 mkdir done")
    diag("test1 write old-file start")
    await writeFile(path.join(log.directory, "performance-2000-01-01.jsonl"), "old")
    diag("test1 write old-file done")
    diag("test1 write keep-file start")
    await writeFile(path.join(log.directory, "keep.txt"), "keep")
    diag("test1 write keep-file done")
    log.record("transcript_async_load_ms", 3)
    log.record("transcript_async_load_ms", 7)
    log.mergeClientSummary({ chat_display_ms: { count: 2, total: 60, max: 40 }, messageText: "must not appear" })
    diag("test1 flush start")
    await log.flush()
    diag("test1 flush done")
    diag("test1 readdir start")
    const files = await readdir(log.directory)
    diag("test1 readdir done")
    expect(files).not.toContain("performance-2000-01-01.jsonl")
    expect(files).toContain("keep.txt")
    diag("test1 readFile start")
    const text = await readFile(path.join(log.directory, files.find(name => name.endsWith(".jsonl"))!), "utf8")
    diag("test1 readFile done")
    const row = JSON.parse(text)
    expect(row.metrics.transcript_async_load_ms).toEqual({ count: 2, total: 10, max: 7 })
    expect(row.metrics.client_chat_display_ms).toEqual({ count: 2, total: 60, max: 40 })
    expect(text).not.toContain("must not appear")
    expect(row.memory.rss).toBeGreaterThan(0)
  } finally {
    diag("test1 rm start")
    await rm(directory, { recursive: true, force: true })
    diag("test1 rm done")
  }
})

test("diagnostics stop writing at the daily byte limit", async () => {
  diag("test2 mkdtemp start")
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-limit-"))
  diag("test2 mkdtemp done")
  try {
    const log = new PerformanceLog(directory, 1)
    diag("test2 flush start")
    await log.flush()
    diag("test2 flush done")
    diag("test2 readdir start")
    expect(await readdir(log.directory)).toEqual([])
    diag("test2 readdir done")
  } finally {
    diag("test2 rm start")
    await rm(directory, { recursive: true, force: true })
    diag("test2 rm done")
  }
})
