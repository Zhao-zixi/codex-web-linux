import { DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES, trimTranscriptWindow } from "../../shared/transcript-window"
import type { ChatSnapshot, TranscriptEntry } from "../../shared/types"

/**
 * Local cache of each chat's loaded transcript window.
 *
 * Transcripts are append-only for the life of a `chatId` — entries are never
 * rewritten and the file is only ever replaced by deleting the chat outright —
 * so a cached window never needs invalidating, only extending. That is what
 * lets a reopened chat resume from its cached position instead of pulling the
 * whole window down again.
 *
 * Only the transcript body is stored. Runtime state (status, queued messages,
 * the read anchor) is small, changes independently, and would be stale on
 * open, so it always comes from the server.
 */

const DATABASE_NAME = "kanna:chat-transcripts"
const DATABASE_VERSION = 1
const STORE_NAME = "windows"

/**
 * Bumped when the cached shape changes. Entries written by an older version
 * fail the check and are treated as a cold cache rather than migrated.
 */
const CACHE_SCHEMA_VERSION = 2

/** Windows past this age are dropped on open — stale chats are not worth disk. */
const MAX_ENTRY_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long to wait after the last change before writing. Encoding a window is
 * not free, and an active turn changes it many times a second.
 */
const WRITE_DEBOUNCE_MS = 500

/**
 * Ceiling on one chat's cached window. Trimming keeps a whole transcript well
 * under this, so the cap only catches pathological chats — and skipping the
 * write leaves whatever smaller window is already stored, which is still a
 * valid prefix to resume from.
 */
const MAX_CACHED_WINDOW_BYTES = 8 * 1024 * 1024

export interface CachedTranscriptWindow {
  schemaVersion: number
  chatId: string
  /** Absolute index of `entries[0]`. */
  startIndex: number
  entries: TranscriptEntry[]
  updatedAt: number
}

export interface CachedSpan {
  start: number
  end: number
  endEntryId: string
}

/**
 * Chats held in memory. The memory copy is what a reopened chat resumes from,
 * so it holds the live window by reference — kept current on every push,
 * streaming included, at no cost beyond a map write.
 */
const MAX_MEMORY_WINDOWS = 16

const memoryWindows = new Map<string, CachedTranscriptWindow>()
const diskWrites = new Map<string, CachedTranscriptWindow>()
let diskWriteScheduled = false

export function readMemoryCachedWindow(chatId: string) {
  const cached = memoryWindows.get(chatId) ?? null
  if (cached) {
    memoryWindows.delete(chatId)
    memoryWindows.set(chatId, cached)
  }
  return cached
}

function setMemoryWindow(window: CachedTranscriptWindow) {
  memoryWindows.delete(window.chatId)
  memoryWindows.set(window.chatId, window)
  while (memoryWindows.size > MAX_MEMORY_WINDOWS) memoryWindows.delete(memoryWindows.keys().next().value!)
}

/**
 * Point the memory copy at a chat's current window. No copy, no trim, no
 * encoding: this runs on every push of a streaming turn. Readers trim.
 */
export function rememberWindow(chatId: string, snapshot: Pick<ChatSnapshot, "messages" | "startIndex">) {
  if (snapshot.messages.length === 0) return
  setMemoryWindow({
    schemaVersion: CACHE_SCHEMA_VERSION,
    chatId,
    startIndex: snapshot.startIndex,
    entries: snapshot.messages,
    updatedAt: Date.now(),
  })
}

/**
 * Idle time rather than the next task. A write queued as a chat closes used
 * to run in a `setTimeout(0)`, which landed between the click and the next
 * chat's first frame — its size check stringifies the whole window.
 * Safari has no `requestIdleCallback`; a short delay clears the switch there.
 */
function whenIdle(callback: () => void) {
  if (typeof requestIdleCallback === "function") requestIdleCallback(callback, { timeout: 2000 })
  else setTimeout(callback, 250)
}

/** A settled window: held in memory and queued for disk. */
export function persistWindow(chatId: string, snapshot: Pick<ChatSnapshot, "messages" | "startIndex">) {
  if (snapshot.messages.length === 0) return
  retainWindow({
    schemaVersion: CACHE_SCHEMA_VERSION,
    chatId,
    startIndex: snapshot.startIndex,
    entries: snapshot.messages,
    updatedAt: Date.now(),
  })
}

/** Trim the window, hold it in memory, and queue it for disk. */
function retainWindow(value: CachedTranscriptWindow) {
  const trimmed = trimTranscriptWindow(cachedWindowToMessages(value), DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES)
  const window = { ...value, startIndex: trimmed.startIndex, entries: trimmed.messages }
  setMemoryWindow(window)
  diskWrites.set(value.chatId, window)
  while (diskWrites.size > 8) diskWrites.delete(diskWrites.keys().next().value!)
  if (diskWriteScheduled) return
  diskWriteScheduled = true
  whenIdle(() => {
    diskWriteScheduled = false
    const pending = [...diskWrites.values()]
    diskWrites.clear()
    for (const value of pending) {
      if (JSON.stringify(value.entries).length <= MAX_CACHED_WINDOW_BYTES) void writeCachedWindow(value)
    }
  })
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    } catch {
      // Private-mode browsers can throw outright rather than fail the request.
      resolve(null)
      return
    }
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "chatId" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    // A cache is an optimization; losing it must never surface as an error.
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
}

let databasePromise: Promise<IDBDatabase | null> | null = null

function getDatabase() {
  databasePromise ??= openDatabase()
  return databasePromise
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

export async function readCachedWindow(chatId: string): Promise<CachedTranscriptWindow | null> {
  const db = await getDatabase()
  if (!db) return null
  try {
    const store = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME)
    const value = await requestToPromise(store.get(chatId) as IDBRequest<CachedTranscriptWindow>)
    if (!value || value.schemaVersion !== CACHE_SCHEMA_VERSION) return null
    if (!Array.isArray(value.entries) || value.entries.length === 0) return null
    if (Date.now() - value.updatedAt > MAX_ENTRY_AGE_MS) {
      void deleteCachedWindow(chatId)
      return null
    }
    return value
  } catch {
    return null
  }
}

export async function deleteCachedWindow(chatId: string): Promise<void> {
  memoryWindows.delete(chatId)
  diskWrites.delete(chatId)
  const db = await getDatabase()
  if (!db) return
  try {
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(chatId)
  } catch {
    // Best effort.
  }
}

async function writeCachedWindow(window: CachedTranscriptWindow): Promise<void> {
  const db = await getDatabase()
  if (!db) return
  try {
    db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(window)
  } catch {
    // Quota or a closing connection — the next open just runs cold.
  }
}

/** The span to resume from, or null when there is nothing usable to resume. */
export function toCachedSpan(window: CachedTranscriptWindow | null): CachedSpan | null {
  if (!window || window.entries.length === 0) return null
  const endEntryId = window.entries[window.entries.length - 1]?._id
  if (!endEntryId) return null
  return {
    start: window.startIndex,
    end: window.startIndex + window.entries.length,
    endEntryId,
  }
}

/**
 * Turn a cached window into the snapshot shape the UI renders.
 *
 * Everything outside the transcript is left empty on purpose: this only exists
 * to paint history immediately, and the server's first push — which carries
 * real runtime state — lands right behind it.
 */
export function cachedWindowToMessages(window: CachedTranscriptWindow) {
  return { messages: window.entries, startIndex: window.startIndex }
}

/**
 * Debounced writer, one per chat.
 *
 * Memory follows every change, streaming included (see `rememberWindow`).
 * Disk writes are skipped while a turn is streaming: the window changes many
 * times a second and encoding it repeatedly would put cache work on the
 * streaming path. The turn settling schedules the write that actually matters.
 */
export function createTranscriptCacheWriter() {
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: CachedTranscriptWindow | null = null

  function flush() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const value = pending
    pending = null
    if (!value) return
    // Runs once a turn has settled, so a single stringify of a trimmed
    // transcript is cheap next to the write it guards.
    retainWindow(value)
  }

  return {
    schedule(chatId: string, snapshot: Pick<ChatSnapshot, "messages" | "startIndex">, isStreaming: boolean) {
      if (snapshot.messages.length === 0) return
      rememberWindow(chatId, snapshot)
      pending = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        chatId,
        startIndex: snapshot.startIndex,
        entries: snapshot.messages,
        updatedAt: Date.now(),
      }
      if (isStreaming) {
        if (timer !== null) clearTimeout(timer)
        timer = null
        return
      }
      if (timer !== null) return
      timer = setTimeout(flush, WRITE_DEBOUNCE_MS)
    },
    /** Write whatever is pending now — used when a chat closes mid-turn. */
    flush,
  }
}
