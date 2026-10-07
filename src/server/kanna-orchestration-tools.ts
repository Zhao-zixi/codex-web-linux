import { z } from "zod"
import type { AgentProvider } from "../shared/types"
import type { KannaToolDefinition, KannaToolResult } from "./kanna-tools"
import type { ChatOrchestrator } from "./orchestrator"

/**
 * The chat tools: what a user can do to chats in Kanna, for an agent to do.
 * The rules live in `orchestrator.ts`; these are the schemas and the words
 * the model reads. `harness-instructions.ts` says when to reach for which.
 *
 * The schemas avoid unions on purpose. Each harness converts them its own
 * way (see `kanna-tool-adapters.ts`), and flat optional fields survive all of
 * them.
 */

const runOptions = {
  provider: z.string().optional().describe("claude, codex, cursor, grok or pi. Defaults to the chat's own. get_context lists them."),
  model: z.string().optional().describe("A model id from get_context. Defaults to the chat's own when the provider is unchanged."),
  effort: z.string().optional().describe("Reasoning effort, where the provider has one."),
  planMode: z.boolean().optional().describe("Run read-only, to plan without editing. Always on when this chat is in plan mode."),
}

/**
 * The result goes to the provider as JSON text only, so a large read is not
 * sent twice. The transcript keeps the value itself, which is what a chat
 * card reads the chat's id from.
 */
function reply(value: unknown): KannaToolResult & { transcriptContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], transcriptContent: value }
}

function orchestration(context: { orchestration?: ChatOrchestrator }) {
  if (!context.orchestration) throw new Error("The chat tools are not available in this session.")
  return context.orchestration
}

type Run = { provider?: AgentProvider; model?: string; effort?: string; planMode?: boolean }

const getContext = z.strictObject({})

const listChats = z.strictObject({
  projectId: z.string().optional().describe("Only chats in this project."),
  query: z.string().optional().describe("Text to find in titles and each chat's latest messages."),
  status: z.enum(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]).optional()
    .describe("waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
  parentChatId: z.string().optional().describe("Only sub-chats of this chat."),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
  offset: z.number().int().min(0).optional(),
})

const readChat = z.strictObject({
  chatId: z.string(),
  after: z.number().int().min(-1).optional().describe("Omit for the latest messages. Pass a previous nextCursor to read what came after it, or -1 to read from the start."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 40."),
  view: z.enum(["messages", "activity"]).optional().describe("messages (default) is what was said. activity adds tool calls."),
})

const createChat = z.strictObject({
  message: z.string().min(1).describe("The chat's first message. It sees nothing else of this conversation, so say everything it needs."),
  title: z.string().optional(),
  subchat: z.boolean().optional().describe("Default true: its result is sent back to this chat when it finishes, and stopping this chat stops it. false makes an independent chat for the user."),
  projectId: z.string().optional().describe("Defaults to this chat's project."),
  ...runOptions,
})

const forkChat = z.strictObject({
  chatId: z.string().optional().describe("The chat to copy. Defaults to this one, copied as of its last finished turn."),
  message: z.string().optional().describe("A first message for the copy. Without one it sits idle."),
  title: z.string().optional(),
  subchat: z.boolean().optional().describe("Whether the copy reports back to this chat. Defaults to true when a message is given."),
  ...runOptions,
})

const sendMessage = z.strictObject({
  chatId: z.string(),
  message: z.string().min(1),
  delivery: z.enum(["queue", "steer"]).optional().describe("queue (default) starts it now if the chat is idle and after its current turn otherwise. steer interrupts the current turn to deliver it now."),
  adopt: z.boolean().optional().describe("true adopts the chat: this chat becomes its parent, as if it had started it. Use it when you hand work to an existing chat and need the result. From this message on, its reply arrives here as a message when its turn ends (or through wait_for_chats), it is listed as this chat's sub-chat, and this chat is not finished while that reply is owed. It stays adopted: later messages need no flag, and there is no undo. It is still the user's chat: it stays in their sidebar, and stopping this chat does not stop it, only drops the reply it owes. A chat that had another parent is taken from it, and that parent is told no more results are coming. A chat above this one, in the chain of chats that started it, cannot be adopted. Leave it unset for a message that needs no answer."),
  ...runOptions,
})

const waitForChats = z.strictObject({
  chatIds: z.array(z.string()).min(1).max(16),
  mode: z.enum(["all", "any"]).optional().describe("Return when all have finished (default), or as soon as any has."),
  timeoutSeconds: z.number().int().min(1).max(3600).optional().describe("Default 300."),
})

const cancelChat = z.strictObject({
  chatId: z.string(),
})

const updateChat = z.strictObject({
  chatId: z.string().optional().describe("Defaults to this chat."),
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  done: z.boolean().optional().describe("Mark the chat done, or not done."),
  archived: z.boolean().optional().describe("true puts the chat away; it does not stop a running turn. false brings it back."),
})

const updateQueuedMessage = z.strictObject({
  chatId: z.string(),
  queuedMessageId: z.string().describe("From read_chat's queue."),
  action: z.enum(["remove", "send_now"]).describe("send_now interrupts the chat's current turn to deliver it."),
})

const setSchedule = z.strictObject({
  scheduleId: z.string().optional().describe("Change this schedule. Omit to create one."),
  name: z.string().optional(),
  message: z.string().optional().describe("What to send. Required for a new schedule."),
  chatId: z.string().optional().describe("The chat to send it to. Defaults to this chat."),
  newChat: z.boolean().optional().describe("Send it to a new chat on each run, instead of to an existing one."),
  projectId: z.string().optional().describe("With newChat: the project for the new chats. Defaults to this chat's."),
  inMinutes: z.number().min(0).optional().describe("Once, this many minutes from now."),
  runAt: z.string().optional().describe("Once, at this ISO 8601 time."),
  everyMinutes: z.number().min(1).optional().describe("Repeatedly, this often."),
  dailyAt: z.string().optional().describe("Every day at this 24-hour HH:MM, in the server's time zone (see get_context)."),
  weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("With dailyAt: only these days, 0 for Sunday."),
  enabled: z.boolean().optional().describe("false pauses it."),
  maxRuns: z.number().int().min(1).optional().describe("Stop after this many runs."),
  ...runOptions,
})

const listSchedules = z.strictObject({
  chatId: z.string().optional().describe("Only schedules that send to this chat."),
  includeDisabled: z.boolean().optional(),
})

const deleteSchedule = z.strictObject({
  scheduleId: z.string(),
})

export const ORCHESTRATION_TOOLS: readonly KannaToolDefinition[] = [
  {
    name: "get_context",
    description: "Where you are in Kanna: this chat's id, project, provider and model; the other projects; the providers and models a chat can run on; the current time.",
    schema: getContext,
    async execute(_input, context) {
      return reply(orchestration(context).getContext(context.chatId))
    },
  },
  {
    name: "list_chats",
    description: "List Kanna chats, newest first, with each one's status. Covers every project unless projectId is given.",
    schema: listChats,
    async execute(input, context) {
      return reply(orchestration(context).listChats(listChats.parse(input)))
    },
  },
  {
    name: "read_chat",
    description: "Read a chat: its status, its sub-chats, its queued messages and what was said. Returns the latest messages unless a cursor is given.",
    schema: readChat,
    async execute(input, context) {
      return reply(orchestration(context).readChat(readChat.parse(input)))
    },
  },
  {
    name: "create_chat",
    description: "Start a new chat with a first message, on any provider and model. Returns at once. By default it is a sub-chat of this one: its reply arrives here as a message when its turn ends. If it is still waiting on work it handed off, the message says so and another follows when that work comes back.",
    schema: createChat,
    async execute(input, context) {
      const { message, title, subchat, projectId, ...run } = createChat.parse(input)
      return reply(await orchestration(context).createChat(context.chatId, { message, title, subchat, projectId, ...(run as Run) }))
    },
  },
  {
    name: "fork_chat",
    description: "Copy a chat, conversation included, into a new chat that continues separately. The original is untouched.",
    schema: forkChat,
    async execute(input, context) {
      const { chatId, message, title, subchat, ...run } = forkChat.parse(input)
      return reply(await orchestration(context).forkChat(context.chatId, { chatId, message, title, subchat, ...(run as Run) }))
    },
  },
  {
    name: "send_message",
    description: "Send a message to another chat, as the user would. It starts a turn if the chat is idle and queues behind the current turn otherwise. A chat this one did not start sends nothing back when it finishes, unless this chat adopts it (adopt).",
    schema: sendMessage,
    async execute(input, context) {
      const { chatId, message, delivery, adopt, ...run } = sendMessage.parse(input)
      return reply(await orchestration(context).sendMessage(context.chatId, { chatId, message, delivery, adopt, ...(run as Run) }))
    },
  },
  {
    name: "wait_for_chats",
    description: "Wait until each chat's turn ends, then return its status and last reply. A chat still waiting on work it handed off (waiting_on_subagent, waiting_on_subchats) returns with that status and its reply so far; wait on it again and the wait holds until its next turn ends. Also returns when one stops to ask the user something. A timeout returns what is known so far and stops nothing; call again to keep waiting.",
    schema: waitForChats,
    async execute(input, context) {
      const { chatIds, mode, timeoutSeconds } = waitForChats.parse(input)
      return reply(await orchestration(context).waitForChats(
        context.chatId,
        { chatIds, mode, timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1_000 },
        context.signal,
      ))
    },
  },
  {
    name: "cancel_chat",
    description: "Stop a chat's current turn, and every sub-chat running under it.",
    schema: cancelChat,
    async execute(input, context) {
      return reply(await orchestration(context).cancelChat(context.chatId, cancelChat.parse(input).chatId))
    },
  },
  {
    name: "update_chat",
    description: "Rename a chat, pin it, mark it done, or archive it.",
    schema: updateChat,
    async execute(input, context) {
      return reply(await orchestration(context).updateChat(context.chatId, updateChat.parse(input)))
    },
  },
  {
    name: "update_queued_message",
    description: "Remove a message waiting in a chat's queue, or deliver it now.",
    schema: updateQueuedMessage,
    async execute(input, context) {
      return reply(await orchestration(context).updateQueuedMessage(updateQueuedMessage.parse(input)))
    },
  },
  {
    name: "set_schedule",
    description: "Send a message later, once or on a repeat, to this chat, another chat, or a new chat each time. Give exactly one of inMinutes, runAt, everyMinutes or dailyAt. Pass scheduleId to change or pause one.",
    schema: setSchedule,
    async execute(input, context) {
      const parsed = setSchedule.parse(input)
      return reply(await orchestration(context).setSchedule(context.chatId, { ...parsed, provider: parsed.provider as AgentProvider | undefined }))
    },
  },
  {
    name: "list_schedules",
    description: "List schedules and when each runs next.",
    schema: listSchedules,
    async execute(input, context) {
      return reply(orchestration(context).listSchedules(listSchedules.parse(input)))
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a schedule.",
    schema: deleteSchedule,
    async execute(input, context) {
      return reply(await orchestration(context).deleteSchedule(deleteSchedule.parse(input).scheduleId))
    },
  },
]
