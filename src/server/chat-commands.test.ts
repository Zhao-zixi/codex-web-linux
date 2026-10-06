import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createChatCommands } from "./chat-commands"
import { EventStore } from "./event-store"
import { timestamped } from "./transcript"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-chat-commands-"))
  cleanups.push(() => rm(dataDir, { recursive: true, force: true }))
  const store = new EventStore(dataDir)
  await store.initialize()
  const project = await store.openProject(dataDir)
  const calls: string[] = []
  const tracked: string[] = []
  const agent = {
    send: async () => { calls.push("send"); return { chatId: "c" } },
    enqueue: async () => { calls.push("enqueue"); return { queuedMessageId: "q" } },
    steer: async () => { calls.push("steer") },
    dequeue: async () => { calls.push("dequeue") },
    cancel: async (chatId: string) => { calls.push(`cancel:${chatId}`) },
    closeChat: async (chatId: string) => { calls.push(`close:${chatId}`) },
    forkChat: async () => ({ chatId: "fork" }),
  }
  const commands = createChatCommands({
    store,
    agent: agent as never,
    analytics: { track: (event: string) => { tracked.push(event) } } as never,
  })
  return { store, project, commands, calls, tracked }
}

describe("chat commands", () => {
  test("creating a chat says the sidebar and the project list changed", async () => {
    const { commands, project, store } = await setup()
    const outcome = await commands.create(project.id)
    expect(store.getChat(outcome.result.chatId)).not.toBeNull()
    expect(outcome.changed).toEqual({ sidebar: true, localProjects: true, chatIds: [outcome.result.chatId] })
  })

  test("a chat an agent creates carries its lineage and is not counted as the user's", async () => {
    const { commands, project, store, tracked } = await setup()
    const mine = await commands.create(project.id)
    const theirs = await commands.create(project.id, { createdByChatId: mine.result.chatId, parentChatId: mine.result.chatId })
    expect(store.getChat(theirs.result.chatId)).toMatchObject({ parentChatId: mine.result.chatId, createdByChatId: mine.result.chatId })
    expect(tracked).toEqual(["chat_created"])
  })

  test("archiving an empty chat deletes it, and its own topic is pushed so open tabs see it go", async () => {
    const { commands, project, store } = await setup()
    const empty = (await commands.create(project.id)).result.chatId
    expect((await commands.archive(empty)).changed).toEqual({ sidebar: true, localProjects: true, chatIds: [empty] })
    expect(store.getChat(empty)).toBeNull()

    const used = (await commands.create(project.id)).result.chatId
    await store.appendMessage(used, timestamped({ kind: "user_prompt", content: "hello" }))
    expect((await commands.archive(used)).changed).toEqual({ sidebar: true, localProjects: true })
    expect(store.getChat(used)?.archivedAt).toBeDefined()
  })

  test("restoring a chat marks it done", async () => {
    const { commands, project, store } = await setup()
    const chatId = (await commands.create(project.id)).result.chatId
    await store.appendMessage(chatId, timestamped({ kind: "user_prompt", content: "hello" }))
    await commands.archive(chatId)
    await commands.unarchive(chatId)
    expect(store.getChat(chatId)?.archivedAt).toBeUndefined()
    expect(store.getChat(chatId)?.doneAt).toBeDefined()
  })

  test("deleting stops the chat before it removes it", async () => {
    const { commands, project, store, calls, tracked } = await setup()
    const chatId = (await commands.create(project.id)).result.chatId
    await commands.delete(chatId)
    expect(calls).toEqual([`cancel:${chatId}`, `close:${chatId}`])
    expect(store.getChat(chatId)).toBeNull()
    expect(tracked).toContain("chat_deleted")
  })

  test("a turn pushes its own state, so sending and stopping name no snapshots", async () => {
    const { commands } = await setup()
    expect((await commands.send({ type: "chat.send", chatId: "c", content: "hi" })).changed).toBeNull()
    expect((await commands.cancel("c")).changed).toBeNull()
    expect((await commands.enqueue({ type: "message.enqueue", chatId: "c", content: "hi" })).changed).toEqual({ sidebar: true, chatIds: ["c"] })
  })
})
