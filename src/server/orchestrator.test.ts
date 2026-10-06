import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AgentCoordinator } from "./agent"
import { NoopAnalyticsReporter } from "./analytics"
import { AsyncQueue } from "./async-queue"
import { createChatCommands } from "./chat-commands"
import { EventStore } from "./event-store"
import type { HarnessEvent, HarnessTurn } from "./harness-types"
import { KannaToolRuntime } from "./kanna-tools"
import { ChatOrchestrator, MAX_CHAT_DEPTH, MAX_LIVE_CHATS } from "./orchestrator"
import { deriveChatSnapshot } from "./read-models"
import { timestamped } from "./transcript"
import { splitTranscriptEntry } from "./transcript-payloads"
import type { TranscriptEntry } from "../shared/types"
import { stripSystemMessages } from "../shared/message-preview"

/**
 * These run the real coordinator and the real store against a provider whose
 * turns the test ends by hand. The rules under test are mostly about timing:
 * which turn is open when another one closes.
 */

interface FakeTurn {
  chatId: string
  content: string
  planMode: boolean
  events: AsyncQueue<HarnessEvent>
  open: boolean
}

class FakeCodex {
  readonly turns: FakeTurn[] = []

  async startSession() {}
  stopSession() {}
  stopAll() {}
  getResourceCounts() { return {} }

  async startTurn(args: { chatId: string; content: string; planMode: boolean }): Promise<HarnessTurn> {
    const turn: FakeTurn = { chatId: args.chatId, content: args.content, planMode: args.planMode, events: new AsyncQueue(), open: true }
    this.turns.push(turn)
    const end = () => {
      turn.open = false
      turn.events.finish()
    }
    return { provider: "codex", stream: turn.events, interrupt: async () => end(), close: end }
  }

  /** The chat's open turn. */
  turn(chatId: string) {
    const found = [...this.turns].reverse().find((turn) => turn.chatId === chatId && turn.open)
    if (!found) throw new Error(`No open turn for ${chatId}`)
    return found
  }

  turnsFor(chatId: string) {
    return this.turns.filter((turn) => turn.chatId === chatId)
  }

  finish(chatId: string, text: string) {
    const turn = this.turn(chatId)
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "assistant_text", text }) })
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "" }) })
    turn.open = false
    turn.events.finish()
  }

  fail(chatId: string, message: string) {
    const turn = this.turn(chatId)
    turn.events.push({ type: "transcript", entry: timestamped({ kind: "result", subtype: "error", isError: true, durationMs: 0, result: message }) })
    turn.open = false
    turn.events.finish()
  }
}

async function until(condition: () => boolean, label = "condition") {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (condition()) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-orchestrator-data-"))
  const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-orchestrator-project-"))
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(projectDir)
  const codex = new FakeCodex()
  const agent = new AgentCoordinator({
    store,
    onStateChange: () => {},
    codexManager: codex as never,
    generateTitle: async () => ({ title: null, usedFallback: true, failureMessage: null }),
  })
  let clock: number | null = null
  const orchestrator = new ChatOrchestrator({
    store,
    agent,
    commands: createChatCommands({ store, agent, analytics: NoopAnalyticsReporter }),
    push: () => {},
    now: () => clock ?? Date.now(),
  })
  agent.orchestration = orchestrator
  agent.onChatSettled = (chatId) => orchestrator.handleChatSettled(chatId)
  agent.onChatStopped = (chatId) => orchestrator.handleChatStopped(chatId)
  store.onTurnStarted = (chatId) => orchestrator.handleTurnStarted(chatId)
  cleanups.push(async () => {
    orchestrator.dispose()
    agent.dispose()
    await rm(dataDir, { recursive: true, force: true })
    await rm(projectDir, { recursive: true, force: true })
  })

  /** A chat the user started, with a turn open in it. */
  async function userChat(content = "do the thing", options?: { planMode?: boolean }) {
    const chat = await store.createChat(project.id)
    await agent.send({ type: "chat.send", chatId: chat.id, provider: "codex", content, planMode: options?.planMode })
    await until(() => codex.turnsFor(chat.id).length === 1, "the user's turn")
    return chat.id
  }

  return {
    store,
    project,
    codex,
    agent,
    orchestrator,
    userChat,
    setClock: (value: number) => { clock = value },
    prompts: (chatId: string) => store.getMessages(chatId).filter((entry) => entry.kind === "user_prompt"),
  }
}

describe("sub-chats", () => {
  test("a sub-chat starts on its own and links back to the chat that made it", async () => {
    const { orchestrator, codex, store, userChat, prompts } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "audit the parser", title: "Parser audit" })

    expect(child).toMatchObject({ title: "Parser audit", status: "running", parentChatId: root, createdByChatId: root, provider: "codex" })
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: root, reportOwed: true })
    // The sub-chat is told who is talking to it; the transcript keeps the bare message.
    expect(codex.turn(child.chatId).content).toContain("audit the parser")
    expect(codex.turn(child.chatId).content).toContain("not typed by the user")
    expect(prompts(child.chatId)[0]).toMatchObject({ content: "audit the parser", source: { kind: "agent", chatId: root } })
    // And it shows in the parent's task log, where the user can stop it.
    expect(orchestrator.getChildActivities(root)).toMatchObject([{ type: "chat", status: "running", chatId: child.chatId, stoppable: true }])
  })

  test("its result waits for the parent's turn to end, then starts the next one", async () => {
    const { orchestrator, codex, store, userChat, prompts } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "audit the parser" })

    codex.finish(child.chatId, "Found two bugs.")
    await until(() => store.getQueuedMessages(root).length === 1, "the queued report")
    expect(store.getQueuedMessages(root)[0]).toMatchObject({ source: { kind: "report", chatIds: [child.chatId] } })
    expect(codex.turnsFor(root)).toHaveLength(1)

    codex.finish(root, "Started the audit.")
    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    expect(codex.turn(root).content).toContain("Found two bugs.")
    expect(codex.turn(root).content).toContain(`chat id ${child.chatId}`)
    // The agent gets the line saying which chat and how it ended. A reader
    // gets only what the sub-chat said.
    const report = prompts(root)[1]!
    expect(report.kind === "user_prompt" && report.content).toContain("<system-message>\nSub-chat completed:")
    expect(report.kind === "user_prompt" && stripSystemMessages(report.content)).toBe("Found two bugs.")
    expect(prompts(root)[1]).toMatchObject({ source: { kind: "report", chatIds: [child.chatId] } })
    expect(store.getChat(child.chatId)?.reportOwed).toBeUndefined()
    expect(orchestrator.getChildActivities(root)).toMatchObject([{ status: "completed" }])
  })

  test("a parent that has gone idle is woken by the result", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the benchmarks" })
    codex.finish(root, "Benchmarks are running.")
    // Its own turn is over, but it is not finished while the sub-chat runs.
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "waiting_on_subchats", "the parent to go idle")

    codex.finish(child.chatId, "p95 is 40ms.")
    await until(() => codex.turnsFor(root).length === 2, "the parent to wake")
    expect(codex.turn(root).content).toContain("p95 is 40ms.")
  })

  test("a failed sub-chat reports the error", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "deploy" })
    codex.finish(root, "Deploying.")
    codex.fail(child.chatId, "credentials expired")
    await until(() => codex.turnsFor(root).length === 2, "the parent to wake")
    expect(codex.turn(root).content).toContain("Sub-chat failed")
    expect(codex.turn(root).content).toContain("credentials expired")
  })

  test("two results that land together reach the parent as one message", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const first = await orchestrator.createChat(root, { message: "one" })
    const second = await orchestrator.createChat(root, { message: "two" })
    codex.finish(first.chatId, "first done")
    await until(() => store.getQueuedMessages(root).length === 1)
    codex.finish(second.chatId, "second done")
    await until(() => {
      const source = store.getQueuedMessages(root)[0]?.source
      return source?.kind === "report" && source.chatIds.length === 2
    }, "the merged report")
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]!.content).toContain("first done")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("second done")
    expect(stripSystemMessages(store.getQueuedMessages(root)[0]!.content)).toBe("first done\n\n---\n\nsecond done")
  })

  test("results that land at the same instant are still one message", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const chats = await Promise.all(["a", "b", "c"].map((message) => orchestrator.createChat(root, { message })))
    for (const chat of chats) codex.finish(chat.chatId, `${chat.chatId} done`)
    await until(() => {
      const source = store.getQueuedMessages(root)[0]?.source
      return source?.kind === "report" && source.chatIds.length === 3
    }, "all three in one report")
    expect(store.getQueuedMessages(root)).toHaveLength(1)

    // And the parent hears each result exactly once.
    codex.finish(root, "ok")
    await until(() => codex.turnsFor(root).length === 2)
    for (const chat of chats) expect(codex.turn(root).content.split(`${chat.chatId} done`)).toHaveLength(2)
    codex.finish(root, "noted")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "completed")
    expect(codex.turnsFor(root)).toHaveLength(2)
  })

  test("an independent chat reports nothing", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await orchestrator.createChat(root, { message: "separate work", subchat: false })
    expect(other.parentChatId).toBeUndefined()
    expect(other.createdByChatId).toBe(root)
    codex.finish(other.chatId, "done")
    await until(() => orchestrator.readChat({ chatId: other.chatId }).chat.status === "completed")
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("a sub-chat is not finished while its own sub-chat runs", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "do the legwork" })
    codex.finish(child.chatId, "Handed off.")
    await until(() => !codex.turnsFor(child.chatId)[0]!.open)
    await Bun.sleep(30)
    // The middle chat's turn ended, but nothing goes up until the bottom one is in.
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(orchestrator.readChat({ chatId: child.chatId }).chat.status).toBe("waiting_on_subchats")

    codex.finish(grandchild.chatId, "legwork done")
    await until(() => codex.turnsFor(child.chatId).length === 2, "the middle chat to wake")
    codex.finish(child.chatId, "All of it is done.")
    await until(() => store.getQueuedMessages(root).length === 1, "the report to the top")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("All of it is done.")
  })
})

describe("wait_for_chats", () => {
  test("returns the result and keeps it from arriving a second time", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "look it up" })
    const waiting = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 })
    codex.finish(child.chatId, "The answer is 42.")
    const result = await waiting

    expect(result).toMatchObject({ timedOut: false, chats: [{ chatId: child.chatId, status: "completed", finalMessage: "The answer is 42." }] })
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(store.getChat(child.chatId)?.reportOwed).toBeUndefined()
  })

  test("a timeout stops nothing, and the result still comes as a message", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "slow work" })
    const result = await orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 20 })
    expect(result).toMatchObject({ timedOut: true, chats: [{ status: "running" }] })
    expect(codex.turn(child.chatId).open).toBe(true)

    codex.finish(child.chatId, "finally")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
  })

  test("a result already queued as a report is taken back out", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "quick" })
    codex.finish(child.chatId, "done already")
    await until(() => store.getQueuedMessages(root).length === 1)

    const result = await orchestrator.waitForChats(root, { chatIds: [child.chatId] })
    expect(result.chats[0]).toMatchObject({ status: "completed", finalMessage: "done already" })
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("any returns on the first to finish", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat()
    const fast = await orchestrator.createChat(root, { message: "fast" })
    const slow = await orchestrator.createChat(root, { message: "slow" })
    const waiting = orchestrator.waitForChats(root, { chatIds: [fast.chatId, slow.chatId], mode: "any", timeoutMs: 5_000 })
    codex.finish(fast.chatId, "fast done")
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.chats.map((chat) => chat.status)).toEqual(["completed", "running"])
  })

  test("a caller cancelled mid-wait still gets the result as a message", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "work" })
    const abort = new AbortController()
    const waiting = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 }, abort.signal)
    abort.abort()
    await expect(waiting).rejects.toThrow("Cancelled")

    codex.finish(child.chatId, "late result")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
  })
})

describe("stopping", () => {
  test("stopping a chat stops the chats under it, and none of them reports", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "legwork" })

    await agent.cancel(root)
    await until(() => !codex.turnsFor(child.chatId)[0]!.open && !codex.turnsFor(grandchild.chatId)[0]!.open, "both to stop")
    await Bun.sleep(30)
    expect(store.getChat(child.chatId)?.lastTurnOutcome).toBe("cancelled")
    expect(store.getChat(grandchild.chatId)?.lastTurnOutcome).toBe("cancelled")
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(store.getQueuedMessages(child.chatId)).toHaveLength(0)
    expect(codex.turnsFor(root)).toHaveLength(1)
  })

  test("steering a chat leaves its sub-chats running, and tells the new turn about them", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "long job", title: "Long job" })

    await agent.enqueue({ type: "message.enqueue", chatId: root, content: "also update the docs", steer: true })
    await until(() => codex.turnsFor(root).length === 2, "the steered turn")
    expect(codex.turn(child.chatId).open).toBe(true)
    expect(codex.turn(root).content).toContain("Chats you started that are still running")
    expect(codex.turn(root).content).toContain(child.chatId)
  })

  test("an agent that stops its own sub-chat gets no report for it", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "no longer needed" })
    const stopped = await orchestrator.cancelChat(root, child.chatId)
    expect(stopped.status).toBe("cancelled")
    await until(() => !codex.turnsFor(child.chatId)[0]!.open)
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("a sub-chat the user stops from the task log reports that it was stopped", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "work" })
    await agent.stopBackgroundTask(root, `chat:${child.chatId}`)
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("Sub-chat cancelled")
    expect(codex.turnsFor(child.chatId)[0]!.open).toBe(false)
  })

  test("a chat cannot stop or message itself", async () => {
    const { orchestrator, userChat } = await setup()
    const root = await userChat()
    await expect(orchestrator.cancelChat(root, root)).rejects.toThrow("your own turn")
    await expect(orchestrator.sendMessage(root, { chatId: root, message: "hi" })).rejects.toThrow("cannot message itself")
  })
})

describe("limits", () => {
  test("agent-started chats stop nesting at the depth limit", async () => {
    const { orchestrator, userChat } = await setup()
    let current = await userChat()
    for (let depth = 0; depth < MAX_CHAT_DEPTH; depth += 1) {
      current = (await orchestrator.createChat(current, { message: `level ${depth + 1}` })).chatId
    }
    await expect(orchestrator.createChat(current, { message: "one too deep" })).rejects.toThrow("nest")
  })

  test("one conversation can only have so many chats running, however they are nested", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat()
    const first = await orchestrator.createChat(root, { message: "0" })
    for (let index = 1; index < MAX_LIVE_CHATS; index += 1) {
      // Some from the top, some from a sub-chat: both count against the same total.
      await orchestrator.createChat(index % 2 ? first.chatId : root, { message: String(index), subchat: index % 3 !== 0 })
    }
    await expect(orchestrator.createChat(root, { message: "one too many" })).rejects.toThrow("limit")

    // A finished chat frees a place.
    const leaf = [...codex.turns].reverse().find((turn) => turn.open && turn.chatId !== root && turn.chatId !== first.chatId)!
    codex.finish(leaf.chatId, "done")
    await until(() => orchestrator.readChat({ chatId: leaf.chatId }).chat.status === "completed")
    await orchestrator.createChat(root, { message: "fits now", subchat: false })
  })

  test("a chat in plan mode can only start chats in plan mode", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat("plan the migration", { planMode: true })
    await expect(orchestrator.createChat(root, { message: "just do it", planMode: false })).rejects.toThrow("plan mode")
    await expect(orchestrator.createChat(root, { message: "use cursor", provider: "cursor" })).rejects.toThrow("read-only")

    const child = await orchestrator.createChat(root, { message: "investigate" })
    expect(child.planMode).toBe(true)
    expect(codex.turn(child.chatId).planMode).toBe(true)
  })
})

describe("messages between chats", () => {
  test("a message starts an idle chat and queues behind a busy one", async () => {
    const { orchestrator, codex, store, userChat, prompts } = await setup()
    const root = await userChat()
    const other = await userChat("something else")

    const queued = await orchestrator.sendMessage(root, { chatId: other, message: "when you are done, rebase" })
    expect(queued.started).toBe(false)
    expect(store.getQueuedMessages(other)).toMatchObject([{ content: "when you are done, rebase", source: { kind: "agent", chatId: root } }])

    codex.finish(other, "done")
    await until(() => codex.turnsFor(other).length === 2, "the queued message to start")
    expect(prompts(other)[1]).toMatchObject({ content: "when you are done, rebase", source: { kind: "agent", chatId: root } })

    codex.finish(other, "rebased")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    const started = await orchestrator.sendMessage(root, { chatId: other, message: "now push" })
    expect(started.started).toBe(true)
    // It is not this chat's sub-chat, so nothing is owed back.
    expect(store.getChat(other)?.reportOwed).toBeUndefined()
  })

  test("steer delivery interrupts the turn in progress", async () => {
    const { orchestrator, codex, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const sent = await orchestrator.sendMessage(root, { chatId: other, message: "stop, wrong branch", delivery: "steer" })
    expect(sent.started).toBe(true)
    await until(() => codex.turnsFor(other).length === 2)
    expect(codex.turnsFor(other)[0]!.open).toBe(false)
    expect(codex.turn(other).content).toContain("stop, wrong branch")
  })

  test("a queued message can be removed", async () => {
    const { orchestrator, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const queued = await orchestrator.sendMessage(root, { chatId: other, message: "later" })
    await orchestrator.updateQueuedMessage({ chatId: other, queuedMessageId: queued.queuedMessageId!, action: "remove" })
    expect(store.getQueuedMessages(other)).toHaveLength(0)
  })
})

describe("reading and updating", () => {
  test("lists chats with their state and reads one back", async () => {
    const { orchestrator, codex, project, userChat } = await setup()
    const root = await userChat("fix the login bug")
    const child = await orchestrator.createChat(root, { message: "check the session code", title: "Session check" })
    codex.finish(child.chatId, "The cookie is never refreshed.")
    await until(() => orchestrator.readChat({ chatId: child.chatId }).chat.status === "completed")

    const listed = orchestrator.listChats({ projectId: project.id })
    expect(listed.total).toBe(2)
    expect(orchestrator.listChats({ parentChatId: root }).chats.map((chat) => chat.chatId)).toEqual([child.chatId])
    expect(orchestrator.listChats({ query: "session" }).chats.map((chat) => chat.title)).toEqual(["Session check"])
    expect(orchestrator.listChats({ status: "completed" }).chats).toHaveLength(1)

    const read = orchestrator.readChat({ chatId: child.chatId })
    expect(read.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "check the session code"],
      ["assistant", "The cookie is never refreshed."],
    ])
    expect(read.entries[0]!.from).toEqual({ kind: "agent", chatId: root })
    // Reading on from the cursor returns only what came after it.
    expect(orchestrator.readChat({ chatId: child.chatId, after: read.nextCursor }).entries).toEqual([])
    expect(orchestrator.readChat({ chatId: child.chatId, after: -1, limit: 1 })).toMatchObject({ hasMore: true, entries: [{ role: "user" }] })
    expect(orchestrator.readChat({ chatId: root }).subchats.map((chat) => chat.chatId)).toEqual([child.chatId])
  })

  test("renames, pins, marks done and archives", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("other")
    await orchestrator.updateChat(root, { chatId: other, title: "Renamed", pinned: true })
    expect(store.getChat(other)).toMatchObject({ title: "Renamed" })
    expect(store.getChat(other)?.pinnedAt).toBeDefined()

    // Archiving is the user's Archive: it puts the chat away and leaves its turn alone.
    const archived = await orchestrator.updateChat(root, { chatId: other, archived: true })
    expect(archived).toMatchObject({ archived: true })
    expect(codex.turnsFor(other)[0]!.open).toBe(true)
    // And Restore, which also marks it done.
    expect(await orchestrator.updateChat(root, { chatId: other, archived: false })).toMatchObject({ done: true })
    expect(store.getChat(other)?.archivedAt).toBeUndefined()
    // With no chat named, the update is to the chat itself.
    expect((await orchestrator.updateChat(root, { title: "Mine" })).chatId).toBe(root)
  })

  test("get_context names the chat, its project and the providers", async () => {
    const { orchestrator, project, userChat } = await setup()
    const root = await userChat()
    const context = orchestrator.getContext(root)
    expect(context.chat).toMatchObject({ chatId: root, projectId: project.id, projectPath: project.localPath })
    expect(context.projects.map((entry) => entry.projectId)).toEqual([project.id])
    expect(context.providers.map((entry) => entry.provider)).toContain("codex")
  })
})

describe("schedules", () => {
  test("a one-shot sends its message to the chat when it comes due", async () => {
    const { orchestrator, codex, store, userChat, setClock, prompts } = await setup()
    const root = await userChat()
    setClock(1_000_000)
    const schedule = await orchestrator.setSchedule(root, { message: "check the deploy", inMinutes: 10 })
    expect(schedule).toMatchObject({ target: { kind: "chat", chatId: root }, enabled: true, runCount: 0 })

    await orchestrator.runDueSchedules()
    expect(store.getQueuedMessages(root)).toHaveLength(0)

    setClock(1_000_000 + 10 * 60_000)
    await orchestrator.runDueSchedules()
    // The chat is mid-turn, so the message waits in its queue.
    expect(store.getQueuedMessages(root)).toMatchObject([{ content: "check the deploy", source: { kind: "schedule", scheduleId: schedule.scheduleId } }])
    expect(orchestrator.listSchedules({})).toMatchObject({ schedules: [] })
    expect(orchestrator.listSchedules({ includeDisabled: true }).schedules[0]).toMatchObject({ enabled: false, runCount: 1, nextRunAt: null })

    codex.finish(root, "done")
    await until(() => codex.turnsFor(root).length === 2, "the scheduled turn")
    expect(codex.turn(root).content).toContain("sent by the schedule")
    expect(prompts(root)[1]).toMatchObject({ content: "check the deploy", source: { kind: "schedule" } })
  })

  test("a repeating schedule skips a run while its last message is still waiting", async () => {
    const { orchestrator, store, userChat, setClock } = await setup()
    const root = await userChat()
    setClock(0)
    const schedule = await orchestrator.setSchedule(root, { message: "status?", everyMinutes: 5 })
    setClock(5 * 60_000)
    await orchestrator.runDueSchedules()
    setClock(10 * 60_000)
    await orchestrator.runDueSchedules()
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ runCount: 1, enabled: true, nextRunAt: 15 * 60_000 })
  })

  test("a schedule can start a new chat on each run", async () => {
    const { orchestrator, codex, store, project, userChat, setClock } = await setup()
    const root = await userChat()
    setClock(0)
    const schedule = await orchestrator.setSchedule(root, { name: "Nightly triage", message: "triage new issues", newChat: true, everyMinutes: 60 })
    setClock(60 * 60_000)
    await orchestrator.runDueSchedules()

    const created = store.getSchedule(schedule.scheduleId)!.lastRunChatId!
    expect(store.getChat(created)).toMatchObject({ projectId: project.id, title: "Nightly triage" })
    expect(codex.turn(created).content).toContain("triage new issues")

    // Still running at the next slot, so no second chat is started.
    setClock(120 * 60_000)
    await orchestrator.runDueSchedules()
    expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ runCount: 1, lastRunChatId: created })
  })

  test("a schedule can be changed, paused and deleted", async () => {
    const { orchestrator, store, userChat, setClock } = await setup()
    const root = await userChat()
    setClock(0)
    const schedule = await orchestrator.setSchedule(root, { message: "ping", everyMinutes: 5 })
    const paused = await orchestrator.setSchedule(root, { scheduleId: schedule.scheduleId, enabled: false })
    expect(paused).toMatchObject({ enabled: false, message: "ping" })
    setClock(60 * 60_000)
    await orchestrator.runDueSchedules()
    expect(store.getQueuedMessages(root)).toHaveLength(0)

    // Turning it back on starts its clock from now, not from when it was paused.
    const resumed = await orchestrator.setSchedule(root, { scheduleId: schedule.scheduleId, enabled: true, message: "pong" })
    expect(resumed).toMatchObject({ enabled: true, message: "pong", nextRunAt: new Date(65 * 60_000).toISOString() })

    // The name comes back with the id: the schedule is gone, and its card has nothing else to call it.
    expect(await orchestrator.deleteSchedule(schedule.scheduleId)).toEqual({ deleted: schedule.scheduleId, name: "ping" })
    expect(store.listSchedules()).toHaveLength(0)
    await expect(orchestrator.deleteSchedule(schedule.scheduleId)).rejects.toThrow("not found")
  })

  test("rejects a schedule with no time, two times, or a bad one", async () => {
    const { orchestrator, userChat } = await setup()
    const root = await userChat()
    await expect(orchestrator.setSchedule(root, { message: "x" })).rejects.toThrow("Say when")
    await expect(orchestrator.setSchedule(root, { message: "x", inMinutes: 1, everyMinutes: 5 })).rejects.toThrow("not several")
    await expect(orchestrator.setSchedule(root, { message: "x", dailyAt: "9am" })).rejects.toThrow("time of day")
    await expect(orchestrator.setSchedule(root, { message: "x", runAt: "tomorrow" })).rejects.toThrow("not a time")
    await expect(orchestrator.setSchedule(root, { inMinutes: 1 })).rejects.toThrow("needs a message")
  })

  test("a chat's snapshot lists its schedules, and each run adds to the history", async () => {
    const { orchestrator, store, agent, userChat, setClock } = await setup()
    const root = await userChat()
    setClock(0)
    const schedule = await orchestrator.setSchedule(root, { message: "status?", everyMinutes: 5 })
    setClock(5 * 60_000)
    await orchestrator.runDueSchedules()
    setClock(10 * 60_000)
    await orchestrator.runDueSchedules()

    const snapshot = deriveChatSnapshot(
      store.state, agent.getActiveStatuses(), agent.getDrainingChatIds(), root, (id) => store.getClientTranscript(id),
    )
    expect(snapshot?.runtime.schedules).toMatchObject([{
      id: schedule.scheduleId,
      name: "status?",
      // The second run found the first still waiting in the queue.
      runs: [{ at: 5 * 60_000, outcome: "sent", chatId: root }, { at: 10 * 60_000, outcome: "skipped" }],
    }])
    // Changing the schedule keeps what it has already done.
    await orchestrator.setSchedule(root, { scheduleId: schedule.scheduleId, name: "Status check" })
    expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ name: "Status check", runCount: 1 })
    expect(store.getSchedule(schedule.scheduleId)?.runs).toHaveLength(2)
  })

  test("schedules and sub-chat links survive a restart", async () => {
    const { orchestrator, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "work" })
    const schedule = await orchestrator.setSchedule(root, { message: "ping", dailyAt: "09:00", weekdays: [1, 3] })

    for (const compacted of [false, true]) {
      if (compacted) await store.compact()
      const reopened = new EventStore(store.dataDir)
      await reopened.initialize()
      expect(reopened.getChat(child.chatId)).toMatchObject({ parentChatId: root, createdByChatId: root, reportOwed: true })
      expect(reopened.getSchedule(schedule.scheduleId)).toMatchObject({
        content: "ping",
        trigger: { kind: "daily", timeOfDay: "09:00", weekdays: [1, 3] },
        createdByChatId: root,
      })
    }
  })
})

describe("the tools", () => {
  test("an agent reaches all of this by tool name, as its own chat", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const emitted: TranscriptEntry[] = []
    const runtime = new KannaToolRuntime({
      chatId: root,
      cwd: "/tmp",
      emit: async (entry) => { emitted.push(entry) },
      requestInput: async () => ({}),
      orchestration: orchestrator,
    })
    const call = async (name: string, input: unknown) => {
      const result = await runtime.execute(name, input)
      return { isError: result.isError, value: result.isError ? result.content[0]!.text : JSON.parse(result.content[0]!.text) }
    }

    expect((await call("get_context", {})).value.chat.chatId).toBe(root)
    const created = await call("create_chat", { message: "audit", title: "Audit" })
    expect(created.value).toMatchObject({ title: "Audit", parentChatId: root })
    // What the transcript keeps is what the chat card is drawn from: the
    // call as an inline `chat` tool, and the result as an object naming the chat.
    expect(emitted[2]).toMatchObject({ kind: "tool_call", tool: { toolKind: "chat", toolName: "create_chat", input: { payload: { message: "audit" } } } })
    expect(emitted[3]).toMatchObject({ kind: "tool_result", content: { chatId: created.value.chatId, title: "Audit" } })
    expect(splitTranscriptEntry(emitted[2]!, () => true).payload).toBeNull()
    const waiting = call("wait_for_chats", { chatIds: [created.value.chatId], timeoutSeconds: 5 })
    codex.finish(created.value.chatId, "audited")
    expect((await waiting).value).toMatchObject({ timedOut: false, chats: [{ finalMessage: "audited" }] })
    expect((await call("list_chats", { parentChatId: root })).value.total).toBe(1)
    expect((await call("read_chat", { chatId: created.value.chatId })).value.entries).toHaveLength(2)
    expect((await call("set_schedule", { message: "ping", inMinutes: 5 })).value.target).toEqual({ kind: "chat", chatId: root })
    // A schedule's card is drawn from the same two things a chat's is.
    const scheduleCall = emitted.find((entry) => entry.kind === "tool_call" && entry.tool.toolName === "set_schedule")!
    expect(scheduleCall).toMatchObject({ tool: { toolKind: "schedule", input: { payload: { message: "ping", inMinutes: 5 } } } })
    expect(splitTranscriptEntry(scheduleCall, () => true).payload).toBeNull()
    expect(emitted[emitted.indexOf(scheduleCall) + 1]).toMatchObject({ kind: "tool_result", content: { name: "ping", scheduleId: expect.any(String) } })
    expect((await call("list_schedules", {})).value.schedules).toHaveLength(1)

    // Errors come back as text the model can act on, not as a thrown call.
    expect(await call("cancel_chat", { chatId: root })).toMatchObject({ isError: true })
    expect(await call("read_chat", { chatId: "nope" })).toMatchObject({ isError: true, value: expect.stringContaining("list_chats") })
    expect(await call("create_chat", { message: "x", extra: 1 })).toMatchObject({ isError: true })
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })
})
