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
import type { ChatChange } from "./chat-commands"
import { deriveChatSnapshot, deriveSidebarData } from "./read-models"
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

async function setup(options?: { closeOutGraceMs?: number }) {
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
  const pushes: ChatChange[] = []
  const orchestrator = new ChatOrchestrator({
    store,
    agent,
    commands: createChatCommands({ store, agent, analytics: NoopAnalyticsReporter }),
    push: (change) => { pushes.push(change) },
    now: () => clock ?? Date.now(),
    closeOutGraceMs: options?.closeOutGraceMs,
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
    pushes,
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

  test("a sub-chat reports when its turn ends, though its own sub-chat still runs, and is not finished", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate", title: "Coordinator" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "do the legwork", title: "Legwork" })
    codex.finish(child.chatId, "Handed off.")
    // The middle chat's turn ended, and that goes up at once, marked as not the end.
    await until(() => store.getQueuedMessages(root).length === 1, "the interim report")
    const interim = store.getQueuedMessages(root)[0]!.content
    expect(interim).toContain("Sub-chat waiting_on_subchats:")
    expect(interim).toContain("Not its last word")
    expect(interim).toContain("\"Legwork\"")
    expect(stripSystemMessages(interim)).toBe("Handed off.")
    expect(orchestrator.readChat({ chatId: child.chatId }).chat.status).toBe("waiting_on_subchats")
    // Still owed: the turn the bottom chat wakes is to be reported too.
    expect(store.getChat(child.chatId)).toMatchObject({ reportOwed: true, reportedThrough: store.getChat(child.chatId)!.lastTurnEndedAt })

    codex.finish(grandchild.chatId, "legwork done")
    await until(() => codex.turnsFor(child.chatId).length === 2, "the middle chat to wake")
    codex.finish(child.chatId, "All of it is done.")
    await until(() => store.getQueuedMessages(root)[0]?.content.includes("All of it is done.") === true, "the report to the top")
    // The top chat had not read the first report, so the second takes its
    // place: one message, the chat named once, as it stands now.
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]).toMatchObject({ source: { kind: "report", chatIds: [child.chatId] } })
    expect(store.getQueuedMessages(root)[0]!.content).toContain("Sub-chat completed:")
    expect(store.getQueuedMessages(root)[0]!.content).not.toContain("Not its last word")
    expect(stripSystemMessages(store.getQueuedMessages(root)[0]!.content)).toBe("All of it is done.")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportedThrough")
  })
})

describe("waiting on a subagent", () => {
  test("a chat whose turn ended while its sub-chat runs is waiting, until the result starts its next turn", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the benchmarks" })
    // Its own turn is still going, so it is running, not waiting.
    expect(agent.getChatStatuses().get(root)).not.toBe("waiting_on_subagent")
    expect(agent.getActiveStatuses().has(root)).toBe(true)

    codex.finish(root, "Benchmarks are running.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent to wait")
    // What the user is shown, in both places a status is read from.
    const sidebar = deriveSidebarData(store.state, agent.getChatStatuses())
    expect(sidebar.projectGroups[0]!.chats.find((chat) => chat.chatId === root)?.status).toBe("waiting_on_subagent")
    const snapshot = deriveChatSnapshot(store.state, agent.getChatStatuses(), new Set(), root, () => ({ messages: [], startIndex: 0, readAnchor: null }))
    expect(snapshot?.runtime.status).toBe("waiting_on_subagent")

    codex.finish(child.chatId, "p95 is 40ms.")
    await until(() => codex.turnsFor(root).length === 2, "the parent to wake")
    expect(agent.getChatStatuses().get(root)).not.toBe("waiting_on_subagent")
    codex.finish(root, "p95 is 40ms, which is fine.")
    await until(() => !agent.getChatStatuses().has(root), "the parent to come to rest")
  })

  test("the wait reaches every chat above the one still going", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "do the legwork" })
    codex.finish(root, "Handed off.")
    codex.finish(child.chatId, "Handed off.")
    // The middle chat's turn ended, which it reports. The top one reads that
    // and is waiting again.
    await until(() => codex.turnsFor(root).length === 2, "the interim report's turn")
    codex.finish(root, "Noted.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent" && agent.getChatStatuses().get(child.chatId) === "waiting_on_subagent", "both to wait")
    // The one doing the work is running, and waits on nothing.
    expect(agent.getChatStatuses().get(grandchild.chatId)).not.toBe("waiting_on_subagent")

    codex.finish(grandchild.chatId, "legwork done")
    await until(() => codex.turnsFor(child.chatId).length === 2, "the middle chat to wake")
    // The middle chat is working again. The top one still waits on it.
    expect(agent.getChatStatuses().get(root)).toBe("waiting_on_subagent")
    codex.finish(child.chatId, "All of it is done.")
    await until(() => codex.turnsFor(root).length === 3, "the top chat to wake")
    codex.finish(root, "Done.")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")
  })

  test("a sub-chat that fails or is stopped ends the wait", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const root = await userChat()
    const failing = await orchestrator.createChat(root, { message: "deploy" })
    const stopped = await orchestrator.createChat(root, { message: "watch the deploy" })
    codex.finish(root, "Deploying.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent to wait")

    codex.fail(failing.chatId, "credentials expired")
    await until(() => codex.turnsFor(root).length === 2, "the failure to wake the parent")
    codex.finish(root, "The deploy failed.")
    // One sub-chat is still going, so the parent is not done yet.
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent to wait again")

    await agent.stopBackgroundTask(root, `chat:${stopped.chatId}`)
    await until(() => codex.turnsFor(root).length === 3, "the stop to wake the parent")
    codex.finish(root, "Stopped the watch.")
    await until(() => !agent.getChatStatuses().has(root), "the parent to come to rest")
  })

  test("stopping the waiting chat stops what it waits on", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "long job" })
    codex.finish(root, "Started.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent to wait")

    await agent.cancel(root)
    await until(() => !codex.turnsFor(child.chatId)[0]!.open, "the sub-chat to stop")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")
    expect(codex.turnsFor(root)).toHaveLength(1)
  })

  test("an agent sees a chat waiting on its provider's background task, and a wait holds for it", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("run the tests")
    codex.finish(other, "The tests are running in the background.")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")

    // A subagent that outlived the turn, as Claude's do.
    agent.applySubagentActivity(other, { kind: "started", id: "a1", type: "subagent", label: "test-runner" })
    expect(orchestrator.readChat({ chatId: other }).chat.status).toBe("waiting_on_subagent")
    expect(orchestrator.listChats({ status: "waiting_on_subagent" }).chats.map((chat) => chat.chatId)).toEqual([other])
    expect(agent.getChatStatuses().get(other)).toBe("waiting_on_subagent")

    let returned = false
    const waiting = orchestrator.waitForChats(root, { chatIds: [other], timeoutMs: 5_000 }).then((result) => {
      returned = true
      return result
    })
    await Bun.sleep(30)
    expect(returned).toBe(false)

    agent.applySubagentActivity(other, { kind: "stopped", id: "a1", failed: false })
    expect(await waiting).toMatchObject({ timedOut: false, chats: [{ chatId: other, status: "completed" }] })
    expect(agent.getChatStatuses().has(other)).toBe(false)
  })

  test("a sub-chat waiting on a background task keeps the chats above it waiting", async () => {
    const { orchestrator, codex, agent, pushes, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "build it" })
    codex.finish(child.chatId, "Building.")
    codex.finish(root, "Asked for a build.")
    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    codex.finish(root, "The build is under way.")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")

    pushes.length = 0
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "a1", type: "subagent", label: "builder" })
    expect(agent.getChatStatuses().get(child.chatId)).toBe("waiting_on_subagent")
    expect(agent.getChatStatuses().get(root)).toBe("waiting_on_subagent")
    // No turn started to say so, and the parent's own page has to hear of it.
    expect(pushes).toContainEqual({ sidebar: true, chatIds: [root] })
    // To an agent the two are told apart: one it can act on, one it cannot.
    expect(orchestrator.readChat({ chatId: child.chatId }).chat.status).toBe("waiting_on_subagent")
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("waiting_on_subchats")

    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "a1", failed: true })
    expect(agent.getChatStatuses().size).toBe(0)
  })

  test("a chat that left a shell running reads as finished, to the user and to an agent", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("start the dev server")
    agent.applySubagentActivity(other, { kind: "started", id: "sh1", type: "shell", label: "bun run dev", stoppable: true })
    codex.finish(other, "The dev server is up on :5173.")
    await until(() => !agent.getActiveStatuses().has(other), "the turn to end")

    // No status at all: at rest, so unread and ready to review like any chat
    // whose turn just ended.
    expect(agent.getChatStatuses().has(other)).toBe(false)
    const row = deriveSidebarData(store.state, agent.getChatStatuses()).projectGroups[0]!.chats.find((chat) => chat.chatId === other)
    expect(row).toMatchObject({ status: "idle", unread: true })
    // The shell is still there to see, and to stop.
    expect(agent.getSubagents(other)).toMatchObject([{ id: "sh1", type: "shell", status: "running", stoppable: true }])

    // An agent is told the same thing the sidebar shows, and is not kept waiting.
    expect(orchestrator.readChat({ chatId: other }).chat.status).toBe("completed")
    expect(orchestrator.listChats({ status: "waiting_on_subagent" }).chats).toEqual([])
    expect(await orchestrator.waitForChats(root, { chatIds: [other], timeoutMs: 5_000 })).toMatchObject({
      timedOut: false,
      chats: [{ chatId: other, status: "completed", finalMessage: "The dev server is up on :5173." }],
    })
  })

  test("a shell beside a real subagent: the chat waits on the subagent, and stops waiting when it ends", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const chat = await userChat("review this, with the dev server up")
    agent.applySubagentActivity(chat, { kind: "started", id: "sh1", type: "shell", label: "bun run dev" })
    agent.applySubagentActivity(chat, { kind: "started", id: "a1", type: "subagent", label: "code-reviewer" })
    codex.finish(chat, "The review is running.")
    await until(() => agent.getChatStatuses().get(chat) === "waiting_on_subagent", "the chat to wait")
    expect(orchestrator.readChat({ chatId: chat }).chat.status).toBe("waiting_on_subagent")

    agent.applySubagentActivity(chat, { kind: "stopped", id: "a1", failed: false })
    expect(agent.getChatStatuses().has(chat)).toBe(false)
    expect(orchestrator.readChat({ chatId: chat }).chat.status).toBe("completed")
    expect(agent.getSubagents(chat).find((task) => task.id === "sh1")).toMatchObject({ status: "running" })
  })

  test("a chat that left a monitor running reads as finished, to the user and to an agent", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("watch CI")
    agent.applySubagentActivity(other, { kind: "started", id: "m1", type: "monitor", label: "Watch CI", stoppable: true })
    codex.finish(other, "Watching the run.")
    await until(() => !agent.getActiveStatuses().has(other), "the turn to end")

    // The same answer in both places: at rest, unread, ready to review.
    expect(agent.getChatStatuses().has(other)).toBe(false)
    const row = deriveSidebarData(store.state, agent.getChatStatuses()).projectGroups[0]!.chats.find((chat) => chat.chatId === other)
    expect(row).toMatchObject({ status: "idle", unread: true })
    expect(orchestrator.readChat({ chatId: other }).chat.status).toBe("completed")
    expect(orchestrator.listChats({ status: "waiting_on_subagent" }).chats).toEqual([])
    expect(await orchestrator.waitForChats(root, { chatIds: [other], timeoutMs: 5_000 })).toMatchObject({
      timedOut: false,
      chats: [{ chatId: other, status: "completed", finalMessage: "Watching the run." }],
    })
    // The monitor is still there to see, and to stop.
    expect(agent.getSubagents(other)).toMatchObject([{ id: "m1", type: "monitor", status: "running", stoppable: true }])
  })

  test("a monitor beside a real subagent: the chat waits on the subagent, and stops waiting when it ends", async () => {
    const { orchestrator, codex, agent, userChat } = await setup()
    const chat = await userChat("review this, and watch CI")
    agent.applySubagentActivity(chat, { kind: "started", id: "m1", type: "monitor", label: "Watch CI" })
    agent.applySubagentActivity(chat, { kind: "started", id: "a1", type: "subagent", label: "code-reviewer" })
    codex.finish(chat, "The review is running.")
    await until(() => agent.getChatStatuses().get(chat) === "waiting_on_subagent", "the chat to wait")
    expect(orchestrator.readChat({ chatId: chat }).chat.status).toBe("waiting_on_subagent")

    agent.applySubagentActivity(chat, { kind: "stopped", id: "a1", failed: false })
    expect(agent.getChatStatuses().has(chat)).toBe(false)
    expect(orchestrator.readChat({ chatId: chat }).chat.status).toBe("completed")
    expect(agent.getSubagents(chat).find((task) => task.id === "m1")).toMatchObject({ status: "running" })
  })

  test("a failed turn shows as failed, even with work still going under it", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    await orchestrator.createChat(root, { message: "long job" })
    codex.fail(root, "rate limited")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent's turn to end")
    const sidebar = deriveSidebarData(store.state, agent.getChatStatuses())
    expect(sidebar.projectGroups[0]!.chats.find((chat) => chat.chatId === root)?.status).toBe("failed")
  })

  test("a sub-chat's turn starting pushes the sidebar and every chat above it", async () => {
    const { orchestrator, codex, agent, pushes, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "legwork" })
    for (const chatId of [grandchild.chatId, child.chatId, root]) codex.finish(chatId, "ok")
    // Each report wakes the chat above it once.
    await until(() => codex.turnsFor(child.chatId).length === 2)
    codex.finish(child.chatId, "ok")
    await until(() => codex.turnsFor(root).length === 2)
    codex.finish(root, "ok")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")

    // The user writes to the bottom chat, and both chats above it start waiting.
    pushes.length = 0
    await agent.send({ type: "chat.send", chatId: grandchild.chatId, provider: "codex", content: "one more thing" })
    await until(() => codex.turnsFor(grandchild.chatId).length === 2)
    expect(agent.getChatStatuses().get(root)).toBe("waiting_on_subagent")
    expect(pushes).toContainEqual({ sidebar: true, chatIds: [child.chatId, root] })
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

describe("reporting when a turn ends", () => {
  test("a parent at rest is woken twice: by the reply so far, then by the last one", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "do the legwork" })
    codex.finish(root, "Handed off.")
    codex.finish(child.chatId, "Legwork is under way.")

    await until(() => codex.turnsFor(root).length === 2, "the interim report's turn")
    expect(codex.turn(root).content).toContain("Not its last word")
    expect(codex.turn(root).content).toContain("Legwork is under way.")
    codex.finish(root, "Noted.")
    // Both still read as waiting to the user: work is going under them.
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the top chat to wait again")
    expect(agent.getChatStatuses().get(child.chatId)).toBe("waiting_on_subagent")
    expect(codex.turnsFor(root)).toHaveLength(2)

    codex.finish(grandchild.chatId, "legwork done")
    await until(() => codex.turnsFor(child.chatId).length === 2, "the middle chat to wake")
    codex.finish(child.chatId, "All of it is done.")
    await until(() => codex.turnsFor(root).length === 3, "the last report's turn")
    expect(codex.turn(root).content).toContain("Sub-chat completed:")
    expect(codex.turn(root).content).toContain("All of it is done.")
    expect(codex.turn(root).content).not.toContain("Not its last word")
    codex.finish(root, "Done.")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")
    expect(codex.turnsFor(root)).toHaveLength(3)
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
  })

  test("a sub-chat with nothing going under it reports once, as finished", async () => {
    const { orchestrator, codex, store, userChat } = await setup({ closeOutGraceMs: 20 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "audit the parser" })
    codex.finish(child.chatId, "Found two bugs.")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("Sub-chat completed:")
    expect(store.getQueuedMessages(root)[0]!.content).not.toContain("Not its last word")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    await Bun.sleep(60)
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]).toMatchObject({ source: { chatIds: [child.chatId] } })
  })

  test("a turn that ends with the provider's background work going is reported, and so is the turn that work wakes", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 300 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the tests" })
    codex.finish(root, "Asked for a test run.")
    // A subagent that outlives the turn, as Claude's do.
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "a1", type: "subagent", label: "test-runner" })
    codex.finish(child.chatId, "The tests are running in the background.")

    await until(() => codex.turnsFor(root).length === 2, "the interim report's turn")
    expect(codex.turn(root).content).toContain("Sub-chat waiting_on_subagent:")
    expect(codex.turn(root).content).toContain("work it handed to agents of its own")
    expect(codex.turn(root).content).toContain("The tests are running in the background.")
    codex.finish(root, "Noted.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the parent to wait")

    // The task ends. That is not a turn ending, so nothing goes up yet: the
    // provider's answer to it is the turn to report.
    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "a1", failed: false })
    await Bun.sleep(40)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(store.getChat(child.chatId)?.reportOwed).toBe(true)
    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "(the provider answering its finished task)" })
    await until(() => codex.turnsFor(child.chatId).length === 2, "the woken turn")
    codex.finish(child.chatId, "All 412 tests pass.")

    await until(() => codex.turnsFor(root).length === 3, "the last report's turn")
    expect(codex.turn(root).content).toContain("Sub-chat completed:")
    expect(codex.turn(root).content).toContain("All 412 tests pass.")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    // The clock the task's end started has nothing left to say.
    codex.finish(root, "Good.")
    await Bun.sleep(400)
    expect(codex.turnsFor(root)).toHaveLength(3)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("background work that ends without waking the sub-chat still closes the account with its parent", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 40 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the tests" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "a1", type: "subagent", label: "test-runner" })
    codex.finish(child.chatId, "The tests are running in the background.")
    await until(() => store.getQueuedMessages(root).length === 1, "the interim report")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("Not its last word")

    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "a1", failed: true })
    await until(() => !store.getChat(child.chatId)?.reportOwed, "the account to close")
    await until(() => store.getQueuedMessages(root)[0]?.content.includes("Sub-chat completed:") === true, "the closing report")
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]!.content).not.toContain("Not its last word")
    codex.finish(root, "ok")
    await until(() => codex.turnsFor(root).length === 2)
    codex.finish(root, "noted")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "completed", "the parent to come to rest")
  })

  test("a sub-chat that ends its turn with only a shell running reports as finished, and holds nobody", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 40 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "start the dev server" })
    codex.finish(root, "Asked for a dev server.")
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun run dev" })
    codex.finish(child.chatId, "The dev server is up on :5173.")

    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    const report = codex.turn(root).content
    expect(report).toContain("Sub-chat completed:")
    expect(report).toContain("It left a shell running in the background, which it is not waiting on.")
    expect(report).toContain("The dev server is up on :5173.")
    expect(report).not.toContain("Not its last word")
    // Nothing is owed while the shell runs, so the parent is not held by it.
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    codex.finish(root, "The server is up.")
    await until(() => agent.getChatStatuses().size === 0, "both to come to rest")
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("completed")
    expect(orchestrator.getChildActivities(root)).toMatchObject([{ status: "completed" }])
    // And it stays that way for as long as the shell does.
    await Bun.sleep(80)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(agent.getChatStatuses().size).toBe(0)
  })

  test("the turn a sub-chat's shell wakes is still reported to its parent", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 300 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the tests" })
    codex.finish(root, "Asked for a test run.")
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun test" })
    codex.finish(child.chatId, "The tests are running in the background.")
    await until(() => codex.turnsFor(root).length === 2, "the first report's turn")
    codex.finish(root, "Noted.")
    await until(() => agent.getChatStatuses().size === 0, "both to come to rest")

    // The shell ends. That is not a turn, and the parent has the reply, so
    // nothing goes up and nobody starts waiting.
    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "sh1", failed: false })
    await Bun.sleep(40)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(agent.getChatStatuses().size).toBe(0)

    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "(the provider answering its finished shell)" })
    await until(() => codex.turnsFor(child.chatId).length === 2, "the woken turn")
    // The sub-chat is working again, so its parent waits on it again.
    expect(agent.getChatStatuses().get(root)).toBe("waiting_on_subagent")
    codex.finish(child.chatId, "All 412 tests pass.")

    await until(() => codex.turnsFor(root).length === 3, "the second report's turn")
    expect(codex.turn(root).content).toContain("Sub-chat completed:")
    expect(codex.turn(root).content).toContain("All 412 tests pass.")
    expect(codex.turn(root).content).not.toContain("It left a shell running")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    codex.finish(root, "Good.")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")
  })

  test("a shell that ends without waking the sub-chat is not reported, and a much later turn is not its parent's", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 30 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "start the dev server" })
    codex.finish(root, "Asked for a dev server.")
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun run dev" })
    codex.finish(child.chatId, "The dev server is up.")
    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    codex.finish(root, "ok")
    await until(() => agent.getChatStatuses().size === 0, "both to come to rest")

    // Killed, or stopped from its row. The parent already has the answer.
    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "sh1", failed: false, stopped: true })
    await Bun.sleep(90)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(store.getQueuedMessages(root)).toHaveLength(0)

    // Past the time a provider is given to answer its shell: a turn now is
    // the user's own, in a sub-chat that owes nothing.
    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "one more question" })
    await until(() => codex.turnsFor(child.chatId).length === 2)
    codex.finish(child.chatId, "Answered.")
    await until(() => !agent.getActiveStatuses().has(child.chatId))
    await Bun.sleep(40)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("a wait that returns a sub-chat with a shell running still leaves the turn that shell wakes to be reported", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 300 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the tests" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun test" })
    const waiting = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 })
    codex.finish(child.chatId, "The tests are running in the background.")
    expect(await waiting).toMatchObject({ timedOut: false, chats: [{ status: "completed", finalMessage: "The tests are running in the background." }] })
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)

    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "sh1", failed: false })
    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "(the provider answering its finished shell)" })
    await until(() => codex.turnsFor(child.chatId).length === 2, "the woken turn")
    codex.finish(child.chatId, "All 412 tests pass.")
    await until(() => store.getQueuedMessages(root).length === 1, "the report of the woken turn")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("All 412 tests pass.")
  })

  test("stopping a chat means a sub-chat's shell no longer brings a report back", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 300 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "run the tests" })
    codex.finish(root, "Asked.")
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun test" })
    codex.finish(child.chatId, "Running.")
    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    await agent.cancel(root)

    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "sh1", failed: false })
    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "(the provider answering its finished shell)" })
    await until(() => codex.turnsFor(child.chatId).length === 2)
    codex.finish(child.chatId, "All pass.")
    await until(() => !agent.getActiveStatuses().has(child.chatId))
    await Bun.sleep(40)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(codex.turnsFor(root)).toHaveLength(2)
  })

  test("a sub-chat that ends its turn with only a monitor running reports as finished, and every turn the monitor wakes is reported", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 300 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "watch the deploy" })
    codex.finish(root, "Asked for a watch.")
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "m1", type: "monitor", label: "Watch the deploy log" })
    codex.finish(child.chatId, "Watching the deploy log.")

    await until(() => codex.turnsFor(root).length === 2, "the first report's turn")
    const first = codex.turn(root).content
    expect(first).toContain("Sub-chat completed:")
    expect(first).toContain("It left a monitor running in the background, which it is not waiting on. If that gives it another turn, that turn is reported here too.")
    expect(first).not.toContain("Not its last word")
    // Nothing is owed while it watches, so the parent is not held by it.
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    codex.finish(root, "It is watching.")
    await until(() => agent.getChatStatuses().size === 0, "both to come to rest")
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("completed")

    // The monitor fires, twice, and stays up. Each turn it starts goes up.
    const replies = ["The deploy started.", "The deploy finished."]
    for (const [index, reply] of replies.entries()) {
      await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "(the provider answering its monitor)" })
      await until(() => codex.turnsFor(child.chatId).length === index + 2, "the woken turn")
      expect(agent.getChatStatuses().get(root)).toBe("waiting_on_subagent")
      codex.finish(child.chatId, reply)
      await until(() => codex.turnsFor(root).length === index + 3, "that turn's report")
      expect(codex.turn(root).content).toContain(reply)
      expect(codex.turn(root).content).toContain("It left a monitor running")
      codex.finish(root, "Noted.")
      await until(() => agent.getChatStatuses().size === 0, "both to come to rest again")
    }

    // Once the monitor is over and the time to answer it has passed, a turn
    // in the sub-chat is no longer its parent's to hear of.
    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "m1", failed: false })
    await Bun.sleep(400)
    await agent.send({ type: "chat.send", chatId: child.chatId, provider: "codex", content: "one more question" })
    await until(() => codex.turnsFor(child.chatId).length === 4)
    codex.finish(child.chatId, "Answered.")
    await until(() => !agent.getActiveStatuses().has(child.chatId))
    await Bun.sleep(40)
    expect(codex.turnsFor(root)).toHaveLength(4)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("a sub-chat with a monitor and a real subagent reports as not final, until the subagent is done", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 40 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "review this, and watch CI" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "m1", type: "monitor", label: "Watch CI" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "a1", type: "subagent", label: "code-reviewer" })
    codex.finish(child.chatId, "The review is running.")
    await until(() => store.getQueuedMessages(root).length === 1, "the interim report")
    const interim = store.getQueuedMessages(root)[0]!.content
    expect(interim).toContain("Sub-chat waiting_on_subagent:")
    expect(interim).toContain("Not its last word")
    expect(interim).not.toContain("It left a monitor running")
    expect(store.getChat(child.chatId)?.reportOwed).toBe(true)

    // The subagent ends without waking it. The account closes, and what is
    // left is the monitor, which it is not waiting on.
    agent.applySubagentActivity(child.chatId, { kind: "stopped", id: "a1", failed: false })
    await until(() => store.getQueuedMessages(root)[0]?.content.includes("Sub-chat completed:") === true, "the closing report")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("It left a monitor running")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    expect(agent.getChatStatuses().has(child.chatId)).toBe(false)
  })

  test("a report names everything a sub-chat left running", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "start the server and watch its log" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "sh1", type: "shell", label: "bun run dev" })
    agent.applySubagentActivity(child.chatId, { kind: "started", id: "m1", type: "monitor", label: "Watch the log" })
    codex.finish(child.chatId, "Up, and watching.")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("It left a shell and a monitor running in the background")
  })

  test("a sub-chat that times its own next step reports the turn the schedule starts", async () => {
    const { orchestrator, codex, store, userChat, setClock } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "watch the deploy" })
    setClock(1_000_000)
    const schedule = await orchestrator.setSchedule(child.chatId, { message: "check the deploy", inMinutes: 10, name: "Deploy check" })
    expect(store.getSchedule(schedule.scheduleId)).toMatchObject({ reportsToParent: true })
    // Not for a chat nobody is waiting to hear from, nor for a message to another chat.
    expect(store.getSchedule((await orchestrator.setSchedule(other, { message: "ping", inMinutes: 10 })).scheduleId)).not.toHaveProperty("reportsToParent")
    expect(store.getSchedule((await orchestrator.setSchedule(child.chatId, { chatId: other, message: "ping", inMinutes: 10 })).scheduleId)).not.toHaveProperty("reportsToParent")

    codex.finish(child.chatId, "I will look again in ten minutes.")
    await until(() => store.getQueuedMessages(root).length === 1, "the first report")
    const first = store.getQueuedMessages(root)[0]!.content
    expect(first).toContain("Sub-chat completed:")
    expect(first).toContain('It set itself the schedule "Deploy check"')
    expect(first).toContain("I will look again in ten minutes.")
    // A timer is not work in flight: nothing reads as waiting on it.
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    codex.finish(root, "ok")
    await until(() => codex.turnsFor(root).length === 2)
    codex.finish(root, "Waiting for the check.")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "completed", "the parent to come to rest")

    setClock(1_000_000 + 10 * 60_000)
    await orchestrator.runDueSchedules()
    await until(() => codex.turnsFor(child.chatId).length === 2, "the scheduled turn")
    expect(store.getChat(child.chatId)?.reportOwed).toBe(true)
    codex.finish(child.chatId, "The deploy is live.")
    await until(() => codex.turnsFor(root).length === 3, "the second report's turn")
    expect(codex.turn(root).content).toContain("The deploy is live.")
    // The schedule has run out, so the report no longer promises another.
    expect(codex.turn(root).content).not.toContain("It set itself the schedule")
  })

  test("a failure or a stop between the two reports still reaches the parent", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 40 })
    const root = await userChat()
    const first = await orchestrator.createChat(root, { message: "coordinate" })
    const firstLeaf = await orchestrator.createChat(first.chatId, { message: "legwork" })
    const second = await orchestrator.createChat(root, { message: "coordinate too" })
    await orchestrator.createChat(second.chatId, { message: "legwork too" })
    codex.finish(first.chatId, "Handed off.")
    codex.finish(second.chatId, "Handed off as well.")
    await until(() => {
      const source = store.getQueuedMessages(root)[0]?.source
      return source?.kind === "report" && source.chatIds.length === 2
    }, "both interim reports")

    // One fails in the turn its sub-chat wakes.
    codex.finish(firstLeaf.chatId, "legwork done")
    await until(() => codex.turnsFor(first.chatId).length === 2, "the first to wake")
    codex.fail(first.chatId, "rate limited")
    await until(() => store.getQueuedMessages(root)[0]?.content.includes("Sub-chat failed:") === true, "the failure to be reported")
    expect(store.getQueuedMessages(root)[0]!.content).toContain("rate limited")
    expect(store.getChat(first.chatId)).not.toHaveProperty("reportOwed")

    // The other is stopped by the user while it waits. Its sub-chat stops
    // with it, and the parent hears it is no longer waiting on anything.
    await agent.cancel(second.chatId)
    await until(() => !store.getChat(second.chatId)?.reportOwed, "the stopped chat's account to close")
    await until(() => {
      const report = store.getQueuedMessages(root)[0]
      return report !== undefined && !report.content.includes("Not its last word")
    }, "the closing report")
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]).toMatchObject({ source: { chatIds: [first.chatId, second.chatId] } })
  })

  test("what the parent has heard, and a schedule that reports back, survive a restart", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    await orchestrator.createChat(child.chatId, { message: "legwork" })
    const schedule = await orchestrator.setSchedule(child.chatId, { message: "check", everyMinutes: 30 })
    codex.finish(child.chatId, "Handed off.")
    await until(() => store.getQueuedMessages(root).length === 1, "the interim report")
    const through = store.getChat(child.chatId)!.lastTurnEndedAt

    for (const compacted of [false, true]) {
      if (compacted) await store.compact()
      const reopened = new EventStore(store.dataDir)
      await reopened.initialize()
      expect(reopened.getChat(child.chatId)).toMatchObject({ reportOwed: true, reportedThrough: through })
      expect(reopened.getSchedule(schedule.scheduleId)).toMatchObject({ reportsToParent: true })
    }
  })

  test("stopping the parent between the two reports ends them", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup({ closeOutGraceMs: 20 })
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "legwork" })
    codex.finish(root, "Handed off.")
    codex.finish(child.chatId, "Handed off too.")
    await until(() => codex.turnsFor(root).length === 2, "the interim report's turn")

    await agent.cancel(root)
    await until(() => !codex.turnsFor(grandchild.chatId)[0]!.open, "the chats under it to stop")
    await Bun.sleep(80)
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(codex.turnsFor(root)).toHaveLength(2)
  })

  test("wait_for_chats returns when the turn ends, once, and holds for the next turn after that", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "legwork" })

    const first = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 })
    codex.finish(child.chatId, "Handed off.")
    expect(await first).toMatchObject({ timedOut: false, chats: [{ chatId: child.chatId, status: "waiting_on_subchats", finalMessage: "Handed off." }] })
    // The wait handed that reply over, so it does not also come as a report.
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(store.getChat(child.chatId)).toMatchObject({ reportOwed: true, reportedThrough: store.getChat(child.chatId)!.lastTurnEndedAt })

    // Asked again with nothing new, it holds, and a loop of waits cannot spin.
    let returned = false
    const second = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 }).then((result) => {
      returned = true
      return result
    })
    await Bun.sleep(40)
    expect(returned).toBe(false)

    codex.finish(grandchild.chatId, "legwork done")
    await until(() => codex.turnsFor(child.chatId).length === 2, "the middle chat to wake")
    expect(returned).toBe(false)
    codex.finish(child.chatId, "All of it is done.")
    expect(await second).toMatchObject({ timedOut: false, chats: [{ status: "completed", finalMessage: "All of it is done." }] })
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
  })

  test("a wait takes an interim report that was already queued, and one on a chat that is not the caller's returns at its turn end too", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const stranger = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    await orchestrator.createChat(child.chatId, { message: "legwork" })

    const watching = orchestrator.waitForChats(stranger, { chatIds: [child.chatId], timeoutMs: 5_000 })
    codex.finish(child.chatId, "Handed off.")
    expect(await watching).toMatchObject({ chats: [{ status: "waiting_on_subchats", finalMessage: "Handed off." }] })
    // Nothing of the parent's was taken by a chat that is not the parent.
    await until(() => store.getQueuedMessages(root).length === 1, "the interim report")

    expect(await orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 })).toMatchObject({
      timedOut: false,
      chats: [{ status: "waiting_on_subchats", finalMessage: "Handed off." }],
    })
    expect(store.getQueuedMessages(root)).toHaveLength(0)
    expect(store.getChat(child.chatId)?.reportOwed).toBe(true)
  })

  test("an adopted chat that hands work off holds its adopter until its last report", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    codex.finish(other, "done")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    await orchestrator.sendMessage(root, { chatId: other, message: "ship it", adopt: true })
    const helper = await orchestrator.createChat(other, { message: "run the release checks" })
    codex.finish(root, "Asked.")
    codex.finish(other, "Checks are running.")

    await until(() => codex.turnsFor(root).length === 2, "the interim report's turn")
    expect(codex.turn(root).content).toContain("Not its last word")
    codex.finish(root, "Noted.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the adopter to wait")
    expect(store.getChat(other)?.reportOwed).toBe(true)

    codex.finish(helper.chatId, "checks pass")
    await until(() => codex.turnsFor(other).length === 3, "the adopted chat to wake")
    codex.finish(other, "Shipped.")
    await until(() => codex.turnsFor(root).length === 3, "the last report's turn")
    expect(codex.turn(root).content).toContain("Shipped.")
    codex.finish(root, "Done.")
    await until(() => agent.getChatStatuses().size === 0, "everything to come to rest")
  })
})

describe("adopting", () => {
  /** The chats a project's sidebar lists, as the server sends them. */
  function listed(store: EventStore, agent: AgentCoordinator) {
    const group = deriveSidebarData(store.state, agent.getChatStatuses()).projectGroups[0]!
    return [...group.previewChats, ...group.olderChats].map((chat) => chat.chatId)
  }

  test("a message with adopt makes the sender the parent, and the reply comes back to it", async () => {
    const { orchestrator, codex, store, agent, userChat, prompts } = await setup()
    const root = await userChat()
    const other = await userChat("something else")

    const sent = await orchestrator.sendMessage(root, { chatId: other, message: "rebase onto main", adopt: true })
    expect(sent).toMatchObject({ parentChatId: root, adopted: true, started: false })
    // The user started it, and that is still what the record says.
    expect(store.getChat(other)).toMatchObject({ parentChatId: root, adopted: true, reportOwed: true })
    expect(store.getChat(other)?.createdByChatId).toBeUndefined()
    // Listed under the adopter everywhere a sub-chat is.
    expect(orchestrator.getChildActivities(root)).toMatchObject([{ type: "chat", chatId: other, status: "running" }])
    expect(orchestrator.listChats({ parentChatId: root }).chats.map((chat) => chat.chatId)).toEqual([other])
    expect(orchestrator.readChat({ chatId: root }).subchats).toMatchObject([{ chatId: other, adopted: true }])

    codex.finish(other, "done with the user's work")
    await until(() => codex.turnsFor(other).length === 2, "the adopter's message to start")
    expect(codex.turn(other).content).toContain("It adopted this chat, and your final reply is sent back to it")
    codex.finish(other, "rebased")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")
    expect(store.getQueuedMessages(root)[0]).toMatchObject({ source: { kind: "report", chatIds: [other] } })
    expect(store.getQueuedMessages(root)[0]!.content).toContain("rebased")
    expect(store.getChat(other)?.reportOwed).toBeUndefined()

    // It stays adopted, so the next message earns a report with no flag.
    await orchestrator.sendMessage(root, { chatId: other, message: "now push" })
    expect(store.getChat(other)).toMatchObject({ parentChatId: root, adopted: true, reportOwed: true })
    expect(prompts(other)).toHaveLength(3)

    // The snapshots carry the link and where it came from.
    const row = deriveSidebarData(store.state, agent.getChatStatuses()).projectGroups[0]!.chats.find((chat) => chat.chatId === other)
    expect(row).toMatchObject({ parentChatId: root, adopted: true })
    const snapshot = deriveChatSnapshot(store.state, agent.getChatStatuses(), new Set(), other, () => ({ messages: [], startIndex: 0, readAnchor: null }))
    expect(snapshot?.runtime).toMatchObject({ parentChatId: root, adopted: true })
  })

  test("the push names the chat, its new parent and the one it left", async () => {
    const { orchestrator, pushes, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })

    pushes.length = 0
    await orchestrator.sendMessage(root, { chatId: other, message: "fyi" })
    expect(pushes).toEqual([{ sidebar: true, chatIds: [other] }])

    pushes.length = 0
    await orchestrator.sendMessage(other, { chatId: child.chatId, message: "report to me", adopt: true })
    expect(pushes).toContainEqual({ sidebar: true, chatIds: [child.chatId, other, root] })
  })

  test("without the flag nothing is adopted and nothing is owed", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    for (const adopt of [undefined, false]) {
      const sent = await orchestrator.sendMessage(root, { chatId: other, message: "fyi", adopt })
      expect(sent.parentChatId).toBeUndefined()
      expect(sent.adopted).toBeUndefined()
    }
    expect(store.getChat(other)).not.toHaveProperty("parentChatId")
    expect(store.getChat(other)).not.toHaveProperty("adopted")
    expect(store.getChat(other)).not.toHaveProperty("reportOwed")
    expect(orchestrator.getChildActivities(root)).toEqual([])

    // The user's turn, then one for each message.
    for (const turns of [1, 2, 3]) {
      await until(() => codex.turnsFor(other).length === turns, `turn ${turns}`)
      codex.finish(other, `reply ${turns}`)
    }
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("an adopted chat stays in the sidebar, and one born a sub-chat stays out until it is adopted", async () => {
    const { orchestrator, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    expect(listed(store, agent).sort()).toEqual([other, root].sort())

    await orchestrator.sendMessage(root, { chatId: other, message: "rebase", adopt: true })
    expect(listed(store, agent).sort()).toEqual([other, root].sort())

    // Born a sub-chat, then adopted by another chat: its parent now came from
    // adoption, so it is listed.
    await orchestrator.sendMessage(other, { chatId: child.chatId, message: "report to me", adopt: true })
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: other, adopted: true, createdByChatId: root })
    expect(listed(store, agent).sort()).toEqual([child.chatId, other, root].sort())
  })

  test("the link and where it came from survive a restart", async () => {
    const { orchestrator, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    await orchestrator.sendMessage(root, { chatId: other, message: "rebase", adopt: true })

    for (const compacted of [false, true]) {
      if (compacted) await store.compact()
      const reopened = new EventStore(store.dataDir)
      await reopened.initialize()
      expect(reopened.getChat(other)).toMatchObject({ parentChatId: root, adopted: true, reportOwed: true })
      // A chat an old log made a sub-chat of is one still, with no mark.
      expect(reopened.getChat(child.chatId)).toMatchObject({ parentChatId: root })
      expect(reopened.getChat(child.chatId)).not.toHaveProperty("adopted")
    }
  })

  test("a sub-chat adopted away tells the parent that was waiting for it, and reports to the new one", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    await store.renameChat(other, "Release train")
    const child = await orchestrator.createChat(root, { message: "audit the parser", title: "Parser audit" })
    codex.finish(root, "Handed off.")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "waiting_on_subchats", "the old parent to wait")

    await orchestrator.sendMessage(other, { chatId: child.chatId, message: "report to me instead", adopt: true })
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: other, adopted: true, reportOwed: true })
    // The old parent is woken with the news, not left waiting.
    await until(() => codex.turnsFor(root).length === 2, "the old parent to be told")
    expect(codex.turn(root).content).toContain("Sub-chat adopted:")
    expect(codex.turn(root).content).toContain(`(chat id ${child.chatId})`)
    expect(codex.turn(root).content).toContain("Release train")
    expect(orchestrator.getChildActivities(root)).toEqual([])
    codex.finish(root, "Noted.")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "completed", "the old parent to come to rest")

    codex.finish(child.chatId, "audit one")
    await until(() => codex.turnsFor(child.chatId).length === 2)
    codex.finish(child.chatId, "audit two")
    await until(() => store.getQueuedMessages(other).length === 1, "the report to the new parent")
    expect(store.getQueuedMessages(other)[0]!.content).toContain("audit two")
    await Bun.sleep(30)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("a parent owed nothing hears nothing when its sub-chat is adopted", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    codex.finish(child.chatId, "done")
    await until(() => store.getQueuedMessages(root).length === 1, "the report")

    await orchestrator.sendMessage(other, { chatId: child.chatId, message: "more work", adopt: true })
    await Bun.sleep(30)
    expect(store.getQueuedMessages(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)[0]!.content).not.toContain("Sub-chat adopted")
  })

  test("a chat cannot adopt itself or a chat above it, and adopting its own sub-chat changes nothing", async () => {
    const { orchestrator, store, userChat } = await setup()
    const root = await userChat()
    const child = await orchestrator.createChat(root, { message: "coordinate" })
    const grandchild = await orchestrator.createChat(child.chatId, { message: "legwork" })

    await expect(orchestrator.sendMessage(root, { chatId: root, message: "hi", adopt: true })).rejects.toThrow("cannot message itself")
    await expect(orchestrator.sendMessage(child.chatId, { chatId: root, message: "hi", adopt: true })).rejects.toThrow("loop")
    await expect(orchestrator.sendMessage(grandchild.chatId, { chatId: root, message: "hi", adopt: true })).rejects.toThrow("loop")
    await expect(orchestrator.sendMessage(grandchild.chatId, { chatId: child.chatId, message: "hi", adopt: true })).rejects.toThrow("loop")
    expect(store.getChat(root)).not.toHaveProperty("parentChatId")
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: root })
    expect(store.getQueuedMessages(root)).toHaveLength(0)

    // Already its parent: the chat stays one it started.
    await orchestrator.sendMessage(root, { chatId: child.chatId, message: "status?", adopt: true })
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: root })
    expect(store.getChat(child.chatId)).not.toHaveProperty("adopted")

    // A chat further down can be pulled up: no loop in that.
    await orchestrator.sendMessage(root, { chatId: grandchild.chatId, message: "report to me", adopt: true })
    expect(store.getChat(grandchild.chatId)).toMatchObject({ parentChatId: root, adopted: true })
  })

  test("a send that fails leaves the chat with the parent it had", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    codex.finish(other, "done")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")

    // Refused before anything is written.
    await expect(orchestrator.sendMessage(root, { chatId: other, message: "hi", adopt: true, provider: "nope" as never })).rejects.toThrow("Unknown provider")
    expect(store.getChat(other)).not.toHaveProperty("parentChatId")

    // Written, then taken back when the turn does not start.
    const startTurn = codex.startTurn.bind(codex)
    codex.startTurn = async () => { throw new Error("provider is down") }
    await expect(orchestrator.sendMessage(root, { chatId: other, message: "hi", adopt: true })).rejects.toThrow("did not start")
    expect(store.getChat(other)).not.toHaveProperty("parentChatId")
    expect(store.getChat(other)).not.toHaveProperty("adopted")
    expect(store.getChat(other)).not.toHaveProperty("reportOwed")

    codex.startTurn = startTurn

    // A sub-chat goes back to the parent that started it, as one it started.
    codex.finish(child.chatId, "done")
    await until(() => store.getQueuedMessages(root).length === 1, "the sub-chat's report")
    codex.startTurn = async () => { throw new Error("provider is down") }
    await expect(orchestrator.sendMessage(other, { chatId: child.chatId, message: "hi", adopt: true })).rejects.toThrow("did not start")
    codex.startTurn = startTurn
    expect(store.getChat(child.chatId)).toMatchObject({ parentChatId: root })
    expect(store.getChat(child.chatId)).not.toHaveProperty("adopted")
    expect(store.getChat(child.chatId)).not.toHaveProperty("reportOwed")
    expect(store.getQueuedMessages(root)).toHaveLength(1)
  })

  test("stopping the adopter leaves an adopted chat running, and drops the report it owed", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    await orchestrator.sendMessage(root, { chatId: other, message: "rebase", adopt: true })

    await agent.cancel(root)
    await until(() => !codex.turnsFor(child.chatId)[0]!.open, "the started sub-chat to stop")
    await until(() => !store.getChat(other)?.reportOwed, "the report to be dropped")
    // The user's own turn in it is untouched, and the link stays.
    expect(codex.turnsFor(other)[0]!.open).toBe(true)
    expect(store.getChat(other)).toMatchObject({ parentChatId: root, adopted: true })
    // Stopped means stopped: it is not waiting on the chat it adopted.
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("cancelled")
    expect(agent.getChatStatuses().get(root)).not.toBe("waiting_on_subagent")

    codex.finish(other, "done")
    await until(() => codex.turnsFor(other).length === 2)
    codex.finish(other, "rebased")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    await Bun.sleep(30)
    expect(codex.turnsFor(root)).toHaveLength(1)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("an adopted chat holds its adopter only while it owes a report", async () => {
    const { orchestrator, codex, store, agent, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    await orchestrator.sendMessage(root, { chatId: other, message: "rebase", adopt: true })
    codex.finish(root, "Asked for a rebase.")
    await until(() => agent.getChatStatuses().get(root) === "waiting_on_subagent", "the adopter to wait")
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("waiting_on_subchats")

    codex.finish(other, "done")
    await until(() => codex.turnsFor(other).length === 2)
    codex.finish(other, "rebased")
    await until(() => codex.turnsFor(root).length === 2, "the report's turn")
    codex.finish(root, "Thanks.")
    await until(() => orchestrator.readChat({ chatId: root }).chat.status === "completed")

    // The user goes back to work in the chat. That is not the adopter's wait.
    await agent.send({ type: "chat.send", chatId: other, provider: "codex", content: "one more thing" })
    await until(() => codex.turnsFor(other).length === 3, "the user's turn")
    expect(orchestrator.readChat({ chatId: root }).chat.status).toBe("completed")
    expect(agent.getChatStatuses().get(root)).not.toBe("waiting_on_subagent")
    codex.finish(other, "sure")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    await Bun.sleep(30)
    expect(codex.turnsFor(root)).toHaveLength(2)
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("wait_for_chats takes an adopted chat's result, so it does not also arrive as a report", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    codex.finish(other, "done")
    await until(() => orchestrator.readChat({ chatId: other }).chat.status === "completed")
    await orchestrator.sendMessage(root, { chatId: other, message: "rebase", adopt: true })

    const waiting = orchestrator.waitForChats(root, { chatIds: [other], timeoutMs: 5_000 })
    codex.finish(other, "rebased")
    expect(await waiting).toMatchObject({ timedOut: false, chats: [{ chatId: other, finalMessage: "rebased" }] })
    await Bun.sleep(30)
    expect(store.getChat(other)?.reportOwed).toBeUndefined()
    expect(store.getQueuedMessages(root)).toHaveLength(0)
  })

  test("an agent adopts through send_message, and other fields are still refused", async () => {
    const { orchestrator, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const runtime = new KannaToolRuntime({
      chatId: root,
      cwd: "/tmp",
      emit: async () => {},
      requestInput: async () => ({}),
      orchestration: orchestrator,
    })
    const refused = await runtime.execute("send_message", { chatId: other, message: "rebase", adopted: true })
    expect(refused.isError).toBe(true)
    expect(store.getChat(other)).not.toHaveProperty("parentChatId")

    const sent = await runtime.execute("send_message", { chatId: other, message: "rebase", adopt: true })
    expect(JSON.parse(sent.content[0]!.text)).toMatchObject({ chatId: other, parentChatId: root, adopted: true })
    expect(store.getChat(other)).toMatchObject({ parentChatId: root, adopted: true, reportOwed: true })
  })

  test("a wait the old parent had open does not take the new parent's report", async () => {
    const { orchestrator, codex, store, userChat } = await setup()
    const root = await userChat()
    const other = await userChat("something else")
    const child = await orchestrator.createChat(root, { message: "work" })
    const waiting = orchestrator.waitForChats(root, { chatIds: [child.chatId], timeoutMs: 5_000 })
    await orchestrator.sendMessage(other, { chatId: child.chatId, message: "report to me", adopt: true })

    codex.finish(child.chatId, "one")
    await until(() => codex.turnsFor(child.chatId).length === 2)
    codex.finish(child.chatId, "two")
    // The old parent still gets what it was blocked on, straight from the wait.
    expect(await waiting).toMatchObject({ chats: [{ chatId: child.chatId, finalMessage: "two" }] })
    await until(() => store.getQueuedMessages(other).length === 1, "the report to the new parent")
    expect(store.getQueuedMessages(other)[0]!.content).toContain("two")
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
