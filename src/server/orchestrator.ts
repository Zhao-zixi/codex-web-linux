import type {
  AgentProvider,
  ChatSchedule,
  KannaStatus,
  MessageSource,
  PendingToolSnapshot,
  ScheduleTrigger,
  SubagentActivity,
  TranscriptEntry,
} from "../shared/types"
import type { ChatChange, ChatCommands } from "./chat-commands"
import type { EventStore } from "./event-store"
import type { ChatRecord } from "./events"
import { getServerProviderCatalog, SERVER_PROVIDERS } from "./provider-catalog"
import {
  computeFirstRun,
  MIN_SCHEDULE_INTERVAL_MS,
  parseTimeOfDay,
  ScheduleRunner,
  type ScheduleFireResult,
} from "./schedules"

/**
 * What an agent can do to chats, and the rules that keep that safe.
 *
 * Every write here is something the user can already do from the client, and
 * it runs the same function the WebSocket router runs for the user
 * (`chat-commands.ts`). What this file adds is the actor: each method takes
 * the id of the chat whose agent is asking, and checks the rules that apply
 * to an agent before the command runs.
 *
 * A sub-chat is a chat with a parent link, not a separate kind of object. The
 * link carries three behaviours: the sub-chat's result goes back to the parent
 * as a message, the parent is not finished while the sub-chat runs, and
 * stopping the parent stops the sub-chat.
 */

/** Agent-created chats nest at most this deep below a chat the user started. */
export const MAX_CHAT_DEPTH = 3
/** Chats one user-started chat can have running under it at once, at any depth. */
export const MAX_LIVE_CHATS = 8

const MAX_WAIT_MS = 60 * 60 * 1_000
const DEFAULT_WAIT_MS = 5 * 60 * 1_000
/**
 * How often a wait re-reads its chats. Turn ends wake it directly; this
 * covers the one state with no event of its own, a chat stopping to ask the
 * user something.
 */
const WAIT_POLL_MS = 1_000
/** How far back a chat's final message is looked for. */
const TAIL_ENTRIES = 400
const REPORT_TEXT_LIMIT = 6_000
const READ_ENTRY_TEXT_LIMIT = 4_000
const READ_TOTAL_TEXT_LIMIT = 40_000
const SUBCHAT_TASK_PREFIX = "chat:"
/** Sub-chats listed in a parent's task log. Everything running is always listed. */
const TASK_LOG_CHATS = 20
const BOOT_SWEEP_MS = 60_000

/** The coordinator, as far as the orchestrator needs it. Narrow so tests can stand in for it. */
export interface OrchestratorAgent {
  isBusy(chatId: string): boolean
  hasBackgroundWork(chatId: string): boolean
  isPlanning(chatId: string): boolean
  getActiveStatuses(): Map<string, KannaStatus>
  getPendingTool(chatId: string): PendingToolSnapshot | null
  /** Used directly only for the cascade, which is not an action anyone asked for. */
  cancel(chatId: string): Promise<void>
}

interface OrchestratorArgs {
  store: EventStore
  agent: OrchestratorAgent
  commands: ChatCommands
  /** Push the snapshots an action changed. */
  push: (change: ChatChange) => void
  onError?: (message: string) => void
  now?: () => number
}

/**
 * A chat's state as an agent should read it. `running` covers queued work and
 * the provider's own background tasks; `waiting_on_subchats` is a chat whose
 * own turn ended while chats it started are still going.
 */
export type AgentChatStatus =
  | "idle"
  | "running"
  | "needs_input"
  | "waiting_on_subchats"
  | "completed"
  | "failed"
  | "cancelled"

export interface AgentChatSummary {
  chatId: string
  title: string
  link: string
  projectId: string
  status: AgentChatStatus
  provider: AgentProvider | null
  model?: string
  planMode: boolean
  parentChatId?: string
  forkedFromChatId?: string
  createdByChatId?: string
  lastMessageAt?: string
  turnCount: number
  queuedMessages: number
  archived?: true
  pinned?: true
  done?: true
  unread?: true
}

export interface ChatOutcome {
  chatId: string
  title: string
  link: string
  status: AgentChatStatus
  /** The chat's last reply, or the error that ended its turn. */
  finalMessage?: string
  /** What the chat is asking the user, when `status` is `needs_input`. */
  question?: string
}

export interface ReadChatEntry {
  /** Position in the transcript. Pass the last one back as `after` to read on. */
  index: number
  role: "user" | "assistant" | "tool" | "system"
  text: string
  at: string
  /** Set when a user-role message did not come from the user. */
  from?: MessageSource
  truncated?: true
  error?: true
}

interface RunOptions {
  provider?: AgentProvider
  model?: string
  effort?: string
  planMode?: boolean
}

interface Waiter {
  actorChatId: string
  chatIds: string[]
  check: () => void
}

function chatLink(chatId: string) {
  return `/chat/${chatId}`
}

function clip(text: string, limit: number) {
  if (text.length <= limit) return { text, truncated: false }
  return { text: `${text.slice(0, limit)}…`, truncated: true }
}

function iso(timestamp: number) {
  return new Date(timestamp).toISOString()
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export class ChatOrchestrator {
  private readonly store: EventStore
  private readonly agent: OrchestratorAgent
  private readonly commands: ChatCommands
  private readonly push: (change: ChatChange) => void
  private readonly onError: (message: string) => void
  private readonly now: () => number
  private readonly schedules: ScheduleRunner
  private readonly waiters = new Set<Waiter>()
  /**
   * Sub-chats a `wait_for_chats` from their parent is holding, by chat id.
   * The wait will hand the result to the parent itself, so the report holds
   * back while one is open. That is what keeps a result from arriving twice.
   */
  private readonly claims = new Map<string, number>()
  /** Reports being written, so two turn ends in a row send one. */
  private readonly reporting = new Set<string>()
  /** The last report delivery under way per parent, for the next one to follow. */
  private readonly deliveries = new Map<string, Promise<void>>()
  private childIndex: { version: number; byParent: Map<string, ChatRecord[]> } | null = null
  private bootSweep: ReturnType<typeof setTimeout> | null = null

  constructor(args: OrchestratorArgs) {
    this.store = args.store
    this.agent = args.agent
    this.commands = args.commands
    this.push = args.push
    this.onError = args.onError ?? (() => {})
    this.now = args.now ?? Date.now
    this.schedules = new ScheduleRunner({
      store: this.store,
      fire: (schedule) => this.fireSchedule(schedule),
      onFired: (schedule, result) => {
        // A run can create a chat, which the sidebar and the project list show.
        if (result.outcome === "sent") this.push({ sidebar: true, localProjects: true, chatIds: [result.chatId] })
        // Every run, skipped ones too, is a new line in the schedule's history.
        this.pushSchedule(this.store.getSchedule(schedule.id) ?? schedule)
      },
      onError: (schedule, error) => {
        this.onError(`schedule ${schedule.id} (${schedule.name}) failed to run: ${errorMessage(error)}`)
      },
      now: this.now,
    })
  }

  /**
   * Arms the schedules and sends any report a restart interrupted: a sub-chat
   * that finished just before the process went down still owes its parent.
   */
  start() {
    this.schedules.start()
    this.sweepReports()
    // Once more after boot has resumed what it is going to resume. A sub-chat
    // whose resume was skipped has no turn end coming to send its report.
    this.bootSweep = setTimeout(() => this.sweepReports(), BOOT_SWEEP_MS)
    this.bootSweep.unref?.()
  }

  dispose() {
    this.schedules.dispose()
    if (this.bootSweep) clearTimeout(this.bootSweep)
  }

  private sweepReports() {
    for (const chat of this.store.state.chatsById.values()) {
      if (chat.reportOwed && !chat.deletedAt) void this.maybeReport(chat.id)
    }
  }

  // ── State ──────────────────────────────────────────────────────────────

  private childrenOf(chatId: string): ChatRecord[] {
    const version = this.store.stateVersion
    if (this.childIndex?.version !== version) {
      const byParent = new Map<string, ChatRecord[]>()
      for (const chat of this.store.state.chatsById.values()) {
        if (!chat.parentChatId || chat.deletedAt) continue
        const siblings = byParent.get(chat.parentChatId)
        if (siblings) siblings.push(chat)
        else byParent.set(chat.parentChatId, [chat])
      }
      this.childIndex = { version, byParent }
    }
    return this.childIndex.byParent.get(chatId) ?? []
  }

  /** The chat itself has nothing running and nothing about to run. Says nothing of its sub-chats. */
  private isSelfSettled(chat: ChatRecord) {
    // Cut short by a shutdown and about to be picked back up.
    if (chat.resumePending) return false
    if (this.agent.isBusy(chat.id) || this.agent.hasBackgroundWork(chat.id)) return false
    // A queue normally drains as soon as the turn ends, so messages in it mean
    // a turn is about to start. The exception is a stopped chat, whose queue
    // is parked until someone sends again.
    const queued = this.store.getQueuedMessages(chat.id).length
    return queued === 0 || chat.lastTurnOutcome === "cancelled"
  }

  /**
   * Work is still going in this chat or under it. A sub-chat that has finished
   * but not yet reported counts: its report is about to start a turn here.
   */
  private isLive(chatId: string, seen = new Set<string>()): boolean {
    if (seen.has(chatId)) return false
    seen.add(chatId)
    const chat = this.store.getChat(chatId)
    if (!chat) return false
    if (!this.isSelfSettled(chat)) return true
    return this.childrenOf(chatId).some((child) => this.isReportDue(child) || this.isLive(child.id, seen))
  }

  /**
   * A report from this sub-chat is owed or on its way. "On its way" matters:
   * the flag is cleared before the message is queued, and in between the
   * parent would otherwise look finished to a chat above it.
   */
  private isReportDue(child: ChatRecord) {
    return Boolean(child.reportOwed) || this.reporting.has(child.id)
  }

  private statusOf(chat: ChatRecord): AgentChatStatus {
    if (this.agent.getActiveStatuses().get(chat.id) === "waiting_for_user") return "needs_input"
    if (!this.isSelfSettled(chat)) return "running"
    if (this.childrenOf(chat.id).some((child) => this.isReportDue(child) || this.isLive(child.id))) {
      return "waiting_on_subchats"
    }
    if (chat.lastTurnOutcome === "success") return "completed"
    if (chat.lastTurnOutcome === "failed") return "failed"
    if (chat.lastTurnOutcome === "cancelled") return "cancelled"
    return "idle"
  }

  private summarize(chat: ChatRecord): AgentChatSummary {
    return {
      chatId: chat.id,
      title: chat.title,
      link: chatLink(chat.id),
      projectId: chat.projectId,
      status: this.statusOf(chat),
      provider: chat.provider,
      ...(chat.lastModel ? { model: chat.lastModel } : {}),
      planMode: chat.planMode,
      ...(chat.parentChatId ? { parentChatId: chat.parentChatId } : {}),
      ...(chat.forkedFromChatId ? { forkedFromChatId: chat.forkedFromChatId } : {}),
      ...(chat.createdByChatId ? { createdByChatId: chat.createdByChatId } : {}),
      ...(chat.lastMessageAt ? { lastMessageAt: iso(chat.lastMessageAt) } : {}),
      turnCount: chat.turnCount ?? 0,
      queuedMessages: this.store.getQueuedMessages(chat.id).length,
      ...(chat.archivedAt ? { archived: true as const } : {}),
      ...(chat.pinnedAt ? { pinned: true as const } : {}),
      ...(chat.doneAt ? { done: true as const } : {}),
      ...(chat.unread ? { unread: true as const } : {}),
    }
  }

  private requireChat(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat) throw new Error(`Chat ${chatId} not found. list_chats shows the chats that exist.`)
    return chat
  }

  private tailEntries(chatId: string, count = TAIL_ENTRIES): { entries: TranscriptEntry[]; startIndex: number } {
    const start = Math.max(0, this.store.getTranscriptLength(chatId) - count)
    const transcript = this.store.getClientTranscript(chatId, start)
    return { entries: transcript.messages, startIndex: transcript.startIndex }
  }

  /**
   * How the chat's last turn ended, in words: its final reply, or the error.
   * Only the main agent's own text counts, not a subagent's.
   */
  private outcomeOf(chat: ChatRecord): ChatOutcome {
    const status = this.statusOf(chat)
    const outcome: ChatOutcome = { chatId: chat.id, title: chat.title, link: chatLink(chat.id), status }
    if (status === "needs_input") {
      const question = this.agent.getPendingTool(chat.id)?.preview
      if (question) outcome.question = question
      return outcome
    }
    const { entries } = this.tailEntries(chat.id)
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!
      if (entry.kind === "user_prompt") break
      if (entry.kind === "result" && entry.isError && entry.result && status === "failed") {
        outcome.finalMessage = clip(entry.result, REPORT_TEXT_LIMIT).text
        break
      }
      if (entry.kind === "assistant_text" && !entry.hidden && !entry.parentToolUseId && entry.text.trim()) {
        outcome.finalMessage = clip(entry.text.trim(), REPORT_TEXT_LIMIT).text
        break
      }
    }
    return outcome
  }

  // ── Rules ──────────────────────────────────────────────────────────────

  /** The chat that created this one, followed up to a chat the user started. */
  private creationChain(chatId: string): ChatRecord[] {
    const chain: ChatRecord[] = []
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      chain.push(current)
      current = current.createdByChatId ? this.store.getChat(current.createdByChatId) : null
    }
    return chain
  }

  /**
   * Refuses a new chat that would nest too deep or run too many at once.
   * Both are counted from the chat the user started, across every chat the
   * agents under it created, so a sub-chat cannot get round a limit by
   * starting chats of its own.
   */
  private checkBudget(actorChatId: string) {
    const chain = this.creationChain(actorChatId)
    if (chain.length > MAX_CHAT_DEPTH) {
      throw new Error(`Chats started by agents can nest ${MAX_CHAT_DEPTH} deep, and this chat is already at that depth. Do the work here instead.`)
    }
    const rootId = chain[chain.length - 1]!.id
    let live = 0
    for (const chat of this.store.state.chatsById.values()) {
      if (chat.deletedAt || !chat.createdByChatId || chat.id === rootId) continue
      const chatChain = this.creationChain(chat.id)
      if (chatChain[chatChain.length - 1]!.id === rootId && this.isLive(chat.id)) live += 1
    }
    if (live >= MAX_LIVE_CHATS) {
      throw new Error(`${live} chats started from this conversation are still running, which is the limit. Wait for one to finish (wait_for_chats) or stop one (cancel_chat).`)
    }
  }

  private isParentOf(chatId: string, ancestorId: string) {
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current?.parentChatId && !seen.has(current.id)) {
      if (current.parentChatId === ancestorId) return true
      seen.add(current.id)
      current = this.store.getChat(current.parentChatId)
    }
    return false
  }

  /**
   * The provider, model and mode a message runs with. Unset fields fall back
   * to `defaults`, which is the receiving chat's own last turn, or the
   * sender's for a new chat.
   *
   * A chat in plan mode is read-only, and that is a ceiling: it cannot start
   * or message a chat that would do the editing for it.
   */
  private resolveRun(
    actorChatId: string,
    requested: RunOptions,
    defaults: { provider: AgentProvider | null; model?: string; planMode: boolean; autoPlan: boolean },
  ) {
    const provider = requested.provider ?? defaults.provider ?? "claude"
    if (!SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      throw new Error(`Unknown provider "${provider}". get_context lists the providers.`)
    }
    const catalog = getServerProviderCatalog(provider)
    const sameProvider = provider === defaults.provider
    const planning = this.agent.isPlanning(actorChatId)
    if (planning && !catalog.supportsPlanMode) {
      throw new Error(`This chat is in plan mode, and ${catalog.label} has no read-only mode to match it. Pick a provider with plan mode.`)
    }
    if (planning && requested.planMode === false) {
      throw new Error("This chat is in plan mode, so a chat it starts or messages must be in plan mode too.")
    }
    return {
      provider,
      // A model belongs to its provider, so a default is not carried across a switch.
      model: requested.model ?? (sameProvider ? defaults.model : undefined),
      effort: requested.effort,
      planMode: catalog.supportsPlanMode && (planning || (requested.planMode ?? defaults.planMode)),
      autoPlan: sameProvider && catalog.supportsAutoPlanMode ? defaults.autoPlan : false,
    }
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  getContext(actorChatId: string) {
    const chat = this.requireChat(actorChatId)
    const project = this.store.getProject(chat.projectId)
    return {
      now: iso(this.now()),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      chat: { ...this.summarize(chat), projectPath: project?.localPath },
      projects: this.store.listProjects().map((entry) => ({
        projectId: entry.id,
        title: entry.sidebarTitle ?? entry.title,
        path: entry.localPath,
      })),
      providers: SERVER_PROVIDERS.map((entry) => ({
        provider: entry.id,
        label: entry.label,
        defaultModel: entry.defaultModel,
        models: entry.models.map((model) => model.id),
        efforts: entry.efforts.map((effort) => effort.id),
        supportsPlanMode: entry.supportsPlanMode,
      })),
      limits: { maxDepth: MAX_CHAT_DEPTH, maxLiveChats: MAX_LIVE_CHATS },
    }
  }

  listChats(input: {
    projectId?: string
    query?: string
    status?: AgentChatStatus
    parentChatId?: string
    includeArchived?: boolean
    limit?: number
    offset?: number
  }) {
    const query = input.query?.trim().toLowerCase()
    const matches: AgentChatSummary[] = []
    const chats = [...this.store.state.chatsById.values()]
      .filter((chat) => !chat.deletedAt)
      .sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt))
    for (const chat of chats) {
      if (chat.archivedAt && !input.includeArchived) continue
      if (input.projectId && chat.projectId !== input.projectId) continue
      if (input.parentChatId && chat.parentChatId !== input.parentChatId) continue
      if (query) {
        // Titles and the last message each way. The transcripts are not
        // searched: that is a file read per chat.
        const haystack = `${chat.title}\n${chat.lastUserMessagePreview ?? ""}\n${chat.lastAgentMessagePreview ?? ""}`.toLowerCase()
        if (!haystack.includes(query)) continue
      }
      const summary = this.summarize(chat)
      if (input.status && summary.status !== input.status) continue
      matches.push(summary)
    }
    const offset = input.offset ?? 0
    const limit = input.limit ?? 30
    return {
      total: matches.length,
      chats: matches.slice(offset, offset + limit),
      ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
    }
  }

  readChat(input: { chatId: string; after?: number; limit?: number; view?: "messages" | "activity" }) {
    const chat = this.requireChat(input.chatId)
    const limit = input.limit ?? 40
    const activity = input.view === "activity"
    const total = this.store.getTranscriptLength(chat.id)
    const fromCursor = input.after !== undefined
    // With no cursor only the end is wanted, so only the end is read: enough
    // entries to fill a page even when most of them are tool calls.
    const transcript = this.store.getClientTranscript(
      chat.id,
      fromCursor ? Math.max(0, input.after! + 1) : Math.max(0, total - Math.max(2_000, limit * 50)),
    )

    const readable: ReadChatEntry[] = []
    transcript.messages.forEach((entry, offset) => {
      const index = transcript.startIndex + offset
      const base = { index, at: iso(entry.createdAt) }
      if (entry.hidden) return
      if (entry.kind === "user_prompt") {
        readable.push({ ...base, role: "user", text: entry.content, ...(entry.source ? { from: entry.source } : {}) })
      } else if (entry.kind === "assistant_text") {
        if (!entry.parentToolUseId && entry.text.trim()) readable.push({ ...base, role: "assistant", text: entry.text })
      } else if (entry.kind === "result") {
        if (entry.isError) readable.push({ ...base, role: "system", text: `Turn failed: ${entry.result || "unknown error"}`, error: true })
      } else if (entry.kind === "interrupted") {
        readable.push({ ...base, role: "system", text: "Turn stopped." })
      } else if (activity && entry.kind === "tool_call") {
        readable.push({ ...base, role: "tool", text: `${entry.tool.toolName} ${JSON.stringify(entry.tool.input)}` })
      } else if (activity && entry.kind === "tool_result" && entry.isError) {
        readable.push({ ...base, role: "tool", text: "Tool call failed.", error: true })
      }
    })

    // Reading on from a cursor takes the first page after it. With no cursor
    // the newest page is the one wanted.
    const page = fromCursor ? readable.slice(0, limit) : readable.slice(-limit)
    let budget = READ_TOTAL_TEXT_LIMIT
    const entries: ReadChatEntry[] = []
    for (const entry of page) {
      const clipped = clip(entry.text, Math.min(READ_ENTRY_TEXT_LIMIT, Math.max(200, budget)))
      budget -= clipped.text.length
      entries.push({ ...entry, text: clipped.text, ...(clipped.truncated ? { truncated: true as const } : {}) })
    }
    const last = entries[entries.length - 1]
    const hasMore = fromCursor && readable.length > page.length
    return {
      chat: this.summarize(chat),
      subchats: this.childrenOf(chat.id).map((child) => this.summarize(child)),
      queue: this.store.getQueuedMessages(chat.id).map((message) => ({
        queuedMessageId: message.id,
        text: clip(message.content, 500).text,
        ...(message.source ? { from: message.source } : {}),
      })),
      entries,
      transcriptEntries: total,
      ...(last ? { nextCursor: last.index } : {}),
      ...(hasMore ? { hasMore: true } : {}),
      // Truncated text and tool output are in the file, for an agent that needs them.
      transcriptPath: this.store.getTranscriptPath(chat.id),
    }
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  async createChat(actorChatId: string, input: RunOptions & {
    message: string
    title?: string
    projectId?: string
    subchat?: boolean
  }) {
    const caller = this.requireChat(actorChatId)
    const subchat = input.subchat ?? true
    const projectId = input.projectId ?? caller.projectId
    if (!this.store.getProject(projectId)) {
      throw new Error(`Project ${projectId} not found. get_context lists the projects.`)
    }
    this.checkBudget(actorChatId)
    const run = this.resolveRun(actorChatId, input, {
      provider: caller.provider,
      model: caller.lastModel,
      planMode: false,
      autoPlan: false,
    })

    const created = await this.commands.create(projectId, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    })
    const chat = this.requireChat(created.result.chatId)
    if (input.title?.trim()) await this.commands.rename(chat.id, input.title)
    await this.send(actorChatId, chat, input.message, run, { report: subchat })
    this.push(created.changed!)
    return this.summarize(this.requireChat(chat.id))
  }

  async forkChat(actorChatId: string, input: RunOptions & {
    chatId?: string
    message?: string
    title?: string
    subchat?: boolean
  }) {
    const source = this.requireChat(input.chatId ?? actorChatId)
    // A fork handed work is delegation, so it reports back unless told not to.
    const subchat = input.subchat ?? Boolean(input.message)
    this.checkBudget(actorChatId)
    const forked = await this.commands.fork(source.id, {
      createdByChatId: actorChatId,
      ...(subchat ? { parentChatId: actorChatId } : {}),
    })
    const chat = this.requireChat(forked.result.chatId)
    if (input.title?.trim()) await this.commands.rename(chat.id, input.title)
    if (input.message) {
      const run = this.resolveRun(actorChatId, input, {
        provider: chat.provider,
        model: source.lastModel,
        planMode: chat.planMode,
        autoPlan: chat.autoPlan,
      })
      await this.send(actorChatId, chat, input.message, run, { report: subchat })
    }
    this.push({ ...forked.changed, chatIds: [chat.id] })
    return this.summarize(this.requireChat(chat.id))
  }

  async sendMessage(actorChatId: string, input: RunOptions & {
    chatId: string
    message: string
    delivery?: "queue" | "steer"
  }) {
    if (input.chatId === actorChatId) {
      throw new Error("A chat cannot message itself. Use set_schedule to send this chat a message later.")
    }
    const target = this.requireChat(input.chatId)
    const run = this.resolveRun(actorChatId, input, {
      provider: target.provider,
      model: target.lastModel,
      planMode: target.planMode,
      autoPlan: target.autoPlan,
    })
    const sent = await this.send(actorChatId, target, input.message, run, {
      // Only its own parent is owed a sub-chat's result.
      report: target.parentChatId === actorChatId,
      steer: input.delivery === "steer",
    })
    this.push({ sidebar: true, chatIds: [target.id] })
    return {
      ...this.summarize(this.requireChat(target.id)),
      started: sent.queuedMessageId === undefined,
      ...(sent.queuedMessageId === undefined ? {} : { queuedMessageId: sent.queuedMessageId }),
    }
  }

  /**
   * One chat's agent sending another a message. Returns the queue id when the
   * message is waiting behind a turn, and none when its own turn has started.
   */
  private async send(
    actorChatId: string,
    target: ChatRecord,
    content: string,
    run: ReturnType<ChatOrchestrator["resolveRun"]>,
    options: { report: boolean; steer?: boolean },
  ): Promise<{ queuedMessageId?: string }> {
    const source: MessageSource = { kind: "agent", chatId: actorChatId }
    // Marked before the turn starts: a turn that fails at once still ends, and
    // that end is what sends the report.
    if (options.report) await this.store.setReportOwed(target.id, true)
    try {
      if (options.steer) {
        const { provider, model, effort, planMode, autoPlan } = run
        // A steer either starts the message or throws, so nothing is left queued.
        await this.commands.enqueue(
          { type: "message.enqueue", chatId: target.id, content, provider, model, planMode, autoPlan, steer: true },
          { source, effort },
        )
        return {}
      }
      const sent = await this.commands.send({ type: "chat.send", chatId: target.id, content, ...run }, { source })
      return "queued" in sent.result ? { queuedMessageId: sent.result.queuedMessageId } : {}
    } catch (error) {
      if (options.report) await this.store.setReportOwed(target.id, false).catch(() => {})
      throw new Error(`Chat ${target.id} exists, but its turn did not start: ${errorMessage(error)}`)
    }
  }

  /**
   * Blocks until the chats have settled or one needs the user. A timeout or a
   * cancelled caller stops the wait, never the chats.
   */
  async waitForChats(
    actorChatId: string,
    input: { chatIds: string[]; mode?: "all" | "any"; timeoutMs?: number },
    signal?: AbortSignal,
  ) {
    const chatIds = [...new Set(input.chatIds)]
    if (chatIds.includes(actorChatId)) throw new Error("A chat cannot wait for itself.")
    for (const chatId of chatIds) this.requireChat(chatId)
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, input.timeoutMs ?? DEFAULT_WAIT_MS))

    const stillGoing = (chatId: string) => {
      const chat = this.store.getChat(chatId)
      if (!chat) return false
      const status = this.statusOf(chat)
      return status === "running" || status === "waiting_on_subchats"
    }
    const satisfied = () => {
      const going = chatIds.filter(stillGoing).length
      return input.mode === "any" ? going < chatIds.length : going === 0
    }

    const claimed = chatIds.filter((chatId) => this.store.getChat(chatId)?.parentChatId === actorChatId)
    for (const chatId of claimed) this.claims.set(chatId, (this.claims.get(chatId) ?? 0) + 1)
    let timedOut = false
    let aborted = false
    try {
      if (!satisfied()) {
        await new Promise<void>((resolve) => {
          const waiter: Waiter = {
            actorChatId,
            chatIds,
            check: () => {
              if (!aborted && !timedOut && !satisfied()) return
              clearTimeout(timer)
              clearInterval(poll)
              signal?.removeEventListener("abort", onAbort)
              this.waiters.delete(waiter)
              resolve()
            },
          }
          const onAbort = () => {
            aborted = true
            waiter.check()
          }
          const timer = setTimeout(() => {
            timedOut = true
            waiter.check()
          }, timeoutMs)
          const poll = setInterval(waiter.check, WAIT_POLL_MS)
          signal?.addEventListener("abort", onAbort, { once: true })
          this.waiters.add(waiter)
          if (signal?.aborted) onAbort()
        })
      }
      // The caller's turn ended, so it never sees this result.
      if (aborted) throw new Error("Cancelled")

      const outcomes = chatIds.map((chatId) => this.outcomeOf(this.requireChat(chatId)))
      // The caller now has these results, so they must not also arrive as a
      // report: neither one still owed, nor one already waiting in its queue.
      const delivered = claimed.filter((chatId) => {
        const status = outcomes.find((entry) => entry.chatId === chatId)?.status
        return status !== "running" && status !== "waiting_on_subchats" && status !== "needs_input"
      })
      for (const chatId of delivered) await this.store.setReportOwed(chatId, false)
      await this.dropQueuedReports(actorChatId, delivered)
      return { timedOut: timedOut && !satisfied(), chats: outcomes }
    } finally {
      // Held until here, so no report can slip out between the wait ending
      // and its results being marked as delivered.
      for (const chatId of claimed) {
        const count = (this.claims.get(chatId) ?? 1) - 1
        if (count > 0) this.claims.set(chatId, count)
        else this.claims.delete(chatId)
      }
      // Whatever the wait did not hand over is the report's to deliver again:
      // a sub-chat still going, or every one of them when the caller was cancelled.
      for (const chatId of claimed) void this.maybeReport(chatId)
    }
  }

  async cancelChat(actorChatId: string, chatId: string) {
    if (chatId === actorChatId) throw new Error("This would stop your own turn. Finish your reply instead.")
    const target = this.requireChat(chatId)
    // Whoever stops a sub-chat of its own already knows it ended, so no report.
    if (this.isParentOf(target.id, actorChatId)) await this.store.setReportOwed(target.id, false)
    await this.commands.cancel(target.id)
    this.push({ sidebar: true, chatIds: [target.id] })
    return this.summarize(this.requireChat(target.id))
  }

  async updateChat(actorChatId: string, input: {
    chatId?: string
    title?: string
    pinned?: boolean
    done?: boolean
    archived?: boolean
  }) {
    const chat = this.requireChat(input.chatId ?? actorChatId)
    if (input.title !== undefined && !input.title.trim()) throw new Error("The title cannot be empty.")
    const changes: Array<ChatChange | null> = []
    if (input.title !== undefined) changes.push((await this.commands.rename(chat.id, input.title)).changed)
    if (input.archived === false && chat.archivedAt) changes.push((await this.commands.unarchive(chat.id)).changed)
    if (input.pinned !== undefined) changes.push((await this.commands.setPinned(chat.id, input.pinned)).changed)
    if (input.done !== undefined) changes.push((await this.commands.setDone(chat.id, input.done)).changed)
    if (input.archived && !chat.archivedAt) changes.push((await this.commands.archive(chat.id)).changed)
    this.push({
      sidebar: true,
      localProjects: changes.some((change) => change?.localProjects),
      chatIds: [chat.id],
    })
    // An empty chat is deleted by archiving, so there may be nothing left to describe.
    const updated = this.store.getChat(chat.id)
    return updated ? this.summarize(updated) : { chatId: chat.id, deleted: true as const }
  }

  async updateQueuedMessage(input: { chatId: string; queuedMessageId: string; action: "remove" | "send_now" }) {
    const chat = this.requireChat(input.chatId)
    if (!this.store.getQueuedMessage(chat.id, input.queuedMessageId)) {
      throw new Error(`No queued message ${input.queuedMessageId} in chat ${chat.id}. read_chat lists its queue.`)
    }
    const outcome = input.action === "remove"
      ? await this.commands.dequeue({ type: "message.dequeue", chatId: chat.id, queuedMessageId: input.queuedMessageId })
      : await this.commands.steer({ type: "message.steer", chatId: chat.id, queuedMessageId: input.queuedMessageId })
    this.push(outcome.changed!)
    return this.summarize(this.requireChat(chat.id))
  }

  // ── Schedules ──────────────────────────────────────────────────────────

  async setSchedule(actorChatId: string, input: RunOptions & {
    scheduleId?: string
    name?: string
    message?: string
    chatId?: string
    newChat?: boolean
    projectId?: string
    inMinutes?: number
    runAt?: string
    everyMinutes?: number
    dailyAt?: string
    weekdays?: number[]
    enabled?: boolean
    maxRuns?: number
  }) {
    const caller = this.requireChat(actorChatId)
    const existing = input.scheduleId ? this.store.getSchedule(input.scheduleId) : null
    if (input.scheduleId && !existing) {
      throw new Error(`Schedule ${input.scheduleId} not found. list_schedules shows the schedules that exist.`)
    }
    const now = this.now()

    const trigger = this.parseTrigger(input, now) ?? existing?.trigger
    if (!trigger) throw new Error("Say when it runs: inMinutes, runAt, everyMinutes or dailyAt.")
    const content = input.message ?? existing?.content
    if (!content?.trim()) throw new Error("A schedule needs a message to send.")

    let target = existing?.target
    if (input.newChat) {
      const projectId = input.projectId ?? caller.projectId
      if (!this.store.getProject(projectId)) throw new Error(`Project ${projectId} not found. get_context lists the projects.`)
      target = { kind: "new_chat", projectId }
    } else if (input.chatId || !target) {
      target = { kind: "chat", chatId: this.requireChat(input.chatId ?? actorChatId).id }
    }

    // The message runs later with nobody to hold it to this chat's mode, so
    // a read-only chat can only schedule read-only work.
    const planning = this.agent.isPlanning(actorChatId)
    if (planning && input.planMode === false) {
      throw new Error("This chat is in plan mode, so what it schedules must run in plan mode too.")
    }
    // A new chat has no history to take its provider from, so it takes the
    // scheduling chat's. A message into an existing chat follows that chat.
    const inherit = !existing && target.kind === "new_chat"
    const provider = input.provider ?? existing?.provider ?? (inherit ? caller.provider ?? undefined : undefined)
    if (provider && !SERVER_PROVIDERS.some((entry) => entry.id === provider)) {
      throw new Error(`Unknown provider "${provider}". get_context lists the providers.`)
    }
    const model = input.model ?? existing?.model ?? (inherit && provider === caller.provider ? caller.lastModel : undefined)
    const planMode = planning ? true : input.planMode ?? existing?.planMode
    const triggerChanged = this.parseTrigger(input, now) !== null
    const enabled = input.enabled ?? existing?.enabled ?? true
    const schedule: ChatSchedule = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name?.trim() || existing?.name || clip(content.trim().split("\n")[0]!, 60).text,
      content,
      target,
      trigger,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(input.effort ?? existing?.effort ? { effort: input.effort ?? existing?.effort } : {}),
      ...(planMode !== undefined ? { planMode } : {}),
      enabled,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(existing ? (existing.createdByChatId ? { createdByChatId: existing.createdByChatId } : {}) : { createdByChatId: actorChatId }),
      // Turning one back on, or giving it a new time, starts its clock again.
      nextRunAt: !enabled
        ? existing?.nextRunAt ?? null
        : triggerChanged || !existing || !existing.enabled || existing.nextRunAt == null
          ? computeFirstRun(trigger, now)
          : existing.nextRunAt,
      ...(existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}),
      ...(existing?.lastRunChatId ? { lastRunChatId: existing.lastRunChatId } : {}),
      runCount: existing?.runCount ?? 0,
      ...(input.maxRuns ?? existing?.maxRuns ? { maxRuns: input.maxRuns ?? existing?.maxRuns } : {}),
      ...(existing?.runs ? { runs: existing.runs } : {}),
    }
    if (schedule.enabled && schedule.nextRunAt == null) {
      throw new Error("That time has already passed, so the schedule would never run.")
    }
    await this.store.setSchedule(schedule)
    this.schedules.refresh()
    this.pushSchedule(schedule, existing)
    return this.describeSchedule(schedule)
  }

  private parseTrigger(
    input: { inMinutes?: number; runAt?: string; everyMinutes?: number; dailyAt?: string; weekdays?: number[] },
    now: number,
  ): ScheduleTrigger | null {
    const given = [input.inMinutes, input.runAt, input.everyMinutes, input.dailyAt].filter((value) => value !== undefined)
    if (given.length === 0) return null
    if (given.length > 1) throw new Error("Give one of inMinutes, runAt, everyMinutes or dailyAt, not several.")
    if (input.inMinutes !== undefined) return { kind: "once", at: now + input.inMinutes * 60_000 }
    if (input.runAt !== undefined) {
      const at = Date.parse(input.runAt)
      if (Number.isNaN(at)) throw new Error(`"${input.runAt}" is not a time. Use ISO 8601, such as 2026-01-31T09:00:00-08:00.`)
      return { kind: "once", at }
    }
    if (input.everyMinutes !== undefined) {
      return { kind: "interval", everyMs: Math.max(MIN_SCHEDULE_INTERVAL_MS, input.everyMinutes * 60_000) }
    }
    if (!parseTimeOfDay(input.dailyAt!)) throw new Error(`"${input.dailyAt}" is not a time of day. Use 24-hour HH:MM, such as 09:00.`)
    return { kind: "daily", timeOfDay: input.dailyAt!, ...(input.weekdays?.length ? { weekdays: input.weekdays } : {}) }
  }

  private describeSchedule(schedule: ChatSchedule) {
    return {
      scheduleId: schedule.id,
      name: schedule.name,
      message: schedule.content,
      target: schedule.target,
      trigger: schedule.trigger.kind === "once"
        ? { kind: "once", at: iso(schedule.trigger.at) }
        : schedule.trigger.kind === "interval"
          ? { kind: "interval", everyMinutes: schedule.trigger.everyMs / 60_000 }
          : schedule.trigger,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt == null ? null : iso(schedule.nextRunAt),
      ...(schedule.lastRunAt ? { lastRunAt: iso(schedule.lastRunAt) } : {}),
      ...(schedule.lastRunChatId ? { lastRunChatId: schedule.lastRunChatId } : {}),
      runCount: schedule.runCount,
      ...(schedule.maxRuns ? { maxRuns: schedule.maxRuns } : {}),
      ...(schedule.provider ? { provider: schedule.provider } : {}),
      ...(schedule.model ? { model: schedule.model } : {}),
      ...(schedule.planMode !== undefined ? { planMode: schedule.planMode } : {}),
      ...(schedule.createdByChatId ? { createdByChatId: schedule.createdByChatId } : {}),
    }
  }

  listSchedules(input: { chatId?: string; includeDisabled?: boolean }) {
    return {
      now: iso(this.now()),
      schedules: this.store.listSchedules()
        .filter((schedule) => input.includeDisabled || schedule.enabled)
        .filter((schedule) => !input.chatId || (schedule.target.kind === "chat" && schedule.target.chatId === input.chatId))
        .map((schedule) => this.describeSchedule(schedule)),
    }
  }

  async deleteSchedule(scheduleId: string) {
    const schedule = this.store.getSchedule(scheduleId)
    if (!schedule) {
      throw new Error(`Schedule ${scheduleId} not found. list_schedules shows the schedules that exist.`)
    }
    await this.store.deleteSchedule(scheduleId)
    this.schedules.refresh()
    this.pushSchedule(schedule)
    // The name too: the schedule is gone, and its card has nothing else to call it.
    return { deleted: scheduleId, name: schedule.name }
  }

  /**
   * Push the chats that list a schedule. A chat's snapshot carries the
   * schedules to do with it, so a change to one is a change to those chats.
   */
  private pushSchedule(...schedules: Array<ChatSchedule | null | undefined>) {
    const chatIds = new Set<string>()
    for (const schedule of schedules) {
      if (!schedule) continue
      if (schedule.target.kind === "chat") chatIds.add(schedule.target.chatId)
      if (schedule.createdByChatId) chatIds.add(schedule.createdByChatId)
      if (schedule.lastRunChatId) chatIds.add(schedule.lastRunChatId)
    }
    if (chatIds.size > 0) this.push({ chatIds: [...chatIds] })
  }

  /** Runs whatever is due now. For tests, which have no timers to wait on. */
  async runDueSchedules() {
    await this.schedules.tick()
  }

  private async fireSchedule(schedule: ChatSchedule): Promise<ScheduleFireResult> {
    const source: MessageSource = { kind: "schedule", scheduleId: schedule.id }
    if (schedule.target.kind === "chat") {
      const chat = this.store.getChat(schedule.target.chatId)
      if (!chat) return { outcome: "gone" }
      // The last run's message has not even started. A second copy behind it
      // would only pile up.
      const pending = this.store.getQueuedMessages(chat.id)
        .some((message) => message.source?.kind === "schedule" && message.source.scheduleId === schedule.id)
      if (pending) return { outcome: "skipped" }
      const provider = schedule.provider ?? chat.provider ?? undefined
      await this.commands.send({
        type: "chat.send",
        chatId: chat.id,
        content: schedule.content,
        provider,
        model: schedule.model ?? (provider === chat.provider ? chat.lastModel : undefined),
        effort: schedule.effort,
        planMode: schedule.planMode ?? chat.planMode,
        autoPlan: chat.autoPlan,
      }, { source })
      return { outcome: "sent", chatId: chat.id }
    }

    if (!this.store.getProject(schedule.target.projectId)) return { outcome: "gone" }
    if (schedule.lastRunChatId && this.isLive(schedule.lastRunChatId)) return { outcome: "skipped" }
    const chatId = (await this.commands.create(schedule.target.projectId)).result.chatId
    await this.commands.rename(chatId, schedule.name)
    await this.commands.send({
      type: "chat.send",
      chatId,
      content: schedule.content,
      provider: schedule.provider,
      model: schedule.model,
      effort: schedule.effort,
      planMode: schedule.planMode,
    }, { source })
    return { outcome: "sent", chatId }
  }

  // ── Coordinator hooks ──────────────────────────────────────────────────

  /** A chat ran out of turns. Wakes waits on it and reports it, and any ancestor it was holding up. */
  handleChatSettled(chatId: string) {
    for (const waiter of [...this.waiters]) waiter.check()
    const changed: string[] = []
    const seen = new Set<string>()
    let current = this.store.getChat(chatId)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      void this.maybeReport(current.id)
      if (!current.parentChatId) break
      // The parent's task log lists this chat, so its status there just changed.
      changed.push(current.parentChatId)
      current = this.store.getChat(current.parentChatId)
    }
    if (changed.length > 0) this.push({ sidebar: true, chatIds: changed })
  }

  /** A sub-chat's turn began, which its parent's task log shows. */
  handleTurnStarted(chatId: string) {
    const parentChatId = this.store.getChat(chatId)?.parentChatId
    if (parentChatId) this.push({ chatIds: [parentChatId] })
  }

  /**
   * Someone stopped this chat, so the chats it started stop too. They report
   * nothing: the parent that would read the report is the one being stopped.
   * Each cancel fires this again for the next level down.
   */
  handleChatStopped(chatId: string) {
    for (const child of this.childrenOf(chatId)) {
      if (!this.isReportDue(child) && !this.isLive(child.id)) continue
      void (async () => {
        await this.store.setReportOwed(child.id, false)
        await this.agent.cancel(child.id)
      })().catch((error) => {
        this.onError(`could not stop sub-chat ${child.id}: ${errorMessage(error)}`)
      })
    }
  }

  /**
   * Sub-chats as rows in their parent's task log, next to the provider's own
   * subagents. Read from the store each time, so a restart loses nothing.
   */
  getChildActivities(chatId: string): SubagentActivity[] {
    const children = this.childrenOf(chatId)
    if (children.length === 0) return []
    const activities = children.map((child): SubagentActivity => {
      const status = this.statusOf(child)
      const running = status === "running" || status === "waiting_on_subchats" || status === "needs_input"
      return {
        id: `${SUBCHAT_TASK_PREFIX}${child.id}`,
        type: "chat",
        label: child.title,
        status: running ? "running" : status === "failed" ? "failed" : status === "completed" ? "completed" : "stopped",
        // Its latest turn, so a sub-chat sent a second message times that work
        // and not everything since it was created.
        startedAt: child.lastTurnStartedAt ?? child.createdAt,
        ...(running || child.lastTurnEndedAt == null ? {} : { endedAt: child.lastTurnEndedAt }),
        ...(status === "needs_input" ? { summary: "Waiting for your answer" } : {}),
        ...(running ? { stoppable: true } : {}),
        chatId: child.id,
      }
    })
    const running = activities.filter((activity) => activity.status === "running")
    const finished = activities
      .filter((activity) => activity.status !== "running")
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, Math.max(0, TASK_LOG_CHATS - running.length))
    return [...running, ...finished]
  }

  /** Stops a sub-chat from its row in the parent's task log. False when the id is not one of ours. */
  async stopChildTask(chatId: string, taskId: string) {
    if (!taskId.startsWith(SUBCHAT_TASK_PREFIX)) return false
    const child = this.store.getChat(taskId.slice(SUBCHAT_TASK_PREFIX.length))
    if (!child || child.parentChatId !== chatId) return false
    await this.commands.cancel(child.id)
    return true
  }

  /**
   * Wire-only notes for the harness at the start of a turn: who sent the
   * prompt when it was not the user, and which sub-chats are still running.
   */
  buildTurnNotices(chatId: string, source?: MessageSource): string[] {
    const notices: string[] = []
    if (source?.kind === "agent") {
      const sender = this.store.getChat(source.chatId)
      notices.push(`<system-message>This message was sent by the agent in Kanna chat "${sender?.title ?? "unknown"}" (chat id ${source.chatId}), not typed by the user.${this.store.getChat(chatId)?.parentChatId === source.chatId ? " It started this chat, and your final reply is sent back to it when you finish." : ""}</system-message>`)
    } else if (source?.kind === "report") {
      notices.push("<system-message>This is Kanna reporting on chats you started, not a message from the user. Carry on with what you were doing for the user.</system-message>")
    } else if (source?.kind === "schedule") {
      const schedule = this.store.getSchedule(source.scheduleId)
      notices.push(`<system-message>This message was sent by the schedule "${schedule?.name ?? "unknown"}" (schedule id ${source.scheduleId}), not typed by the user just now.</system-message>`)
    }
    const running = this.childrenOf(chatId).filter((child) => this.isLive(child.id))
    if (running.length > 0) {
      notices.push([
        "<system-message>Chats you started that are still running:",
        ...running.map((child) => `${child.title} (chat id ${child.id})`),
        "Each one's result arrives here as a message when it finishes. Stop any you no longer need with cancel_chat.</system-message>",
      ].join("\n"))
    }
    return notices
  }

  // ── Reports ────────────────────────────────────────────────────────────

  /**
   * The message a parent gets about finished sub-chats.
   *
   * Two readers, so two layers. The line saying which chat and how it ended
   * is for the agent: it goes in a `<system-message>` block, which every place
   * that shows a message leaves out (`stripSystemMessages`). What the sub-chat
   * said is for both, and is the only part the user sees. A rule separates
   * one sub-chat's words from the next, and only where both have some.
   */
  private buildReport(chatIds: string[]) {
    const sections: string[] = []
    let shown = false
    for (const chatId of chatIds) {
      const chat = this.store.getChat(chatId)
      if (!chat) continue
      const outcome = this.outcomeOf(chat)
      const header = `<system-message>\nSub-chat ${outcome.status}: [${chat.title}](${chatLink(chat.id)}) (chat id ${chat.id})\n</system-message>`
      if (!outcome.finalMessage) {
        sections.push(header)
        continue
      }
      sections.push(`${header}\n\n${shown ? "---\n\n" : ""}${outcome.finalMessage}`)
      shown = true
    }
    return sections.join("\n\n")
  }

  /**
   * Sends a finished sub-chat's result to its parent, once.
   *
   * It travels as an ordinary message: the parent's turn starts if it is
   * idle, and it waits its turn in the queue otherwise. A report already
   * waiting there is replaced by one that covers both, so five sub-chats
   * finishing do not cost the parent five turns.
   */
  private async maybeReport(chatId: string) {
    const chat = this.store.getChat(chatId)
    if (!chat?.reportOwed || !chat.parentChatId) return
    if (this.claims.has(chatId) || this.reporting.has(chatId) || this.isLive(chatId)) return
    this.reporting.add(chatId)
    try {
      // Cleared before the send, so a failure cannot leave it to be sent twice.
      await this.store.setReportOwed(chatId, false)
      const parentChatId = chat.parentChatId
      // One at a time per parent: two sub-chats finishing together would each
      // miss the other's report in the queue and send two.
      const previous = this.deliveries.get(parentChatId) ?? Promise.resolve()
      const delivery = previous.then(() => this.deliverReport(parentChatId, chatId))
      const tail = delivery.catch(() => {})
      this.deliveries.set(parentChatId, tail)
      void tail.then(() => {
        if (this.deliveries.get(parentChatId) === tail) this.deliveries.delete(parentChatId)
      })
      await delivery
    } catch (error) {
      this.onError(`could not report sub-chat ${chatId} to its parent: ${errorMessage(error)}`)
    } finally {
      this.reporting.delete(chatId)
    }
  }

  private async deliverReport(parentChatId: string, chatId: string) {
    const parent = this.store.getChat(parentChatId)
    // A report to a chat the user put away would bring it back uninvited.
    if (!parent || parent.archivedAt) return
    let chatIds = [chatId]
    const waiting = this.store.getQueuedMessages(parent.id).find((message) => message.source?.kind === "report")
    if (waiting?.source?.kind === "report") {
      const merged = [...waiting.source.chatIds, chatId]
      // If it is gone by now the parent's turn ended and took it, and those
      // results are already delivered.
      await this.store.removeQueuedMessage(parent.id, waiting.id).then(() => { chatIds = merged }, () => {})
    }
    await this.commands.send({
      type: "chat.send",
      chatId: parent.id,
      content: this.buildReport(chatIds),
      // The parent carries on as it was running: same model and mode.
      provider: parent.provider ?? undefined,
      model: parent.lastModel,
      planMode: parent.planMode,
      autoPlan: parent.autoPlan,
    }, { source: { kind: "report", chatIds } })
    this.push({ sidebar: true, chatIds: [parent.id] })
  }

  /** Takes results the parent already has out of a report still waiting in its queue. */
  private async dropQueuedReports(parentChatId: string, chatIds: string[]) {
    if (chatIds.length === 0) return
    const waiting = this.store.getQueuedMessages(parentChatId).find((message) => message.source?.kind === "report")
    if (waiting?.source?.kind !== "report") return
    const remaining = waiting.source.chatIds.filter((chatId) => !chatIds.includes(chatId))
    if (remaining.length === waiting.source.chatIds.length) return
    await this.store.removeQueuedMessage(parentChatId, waiting.id).catch(() => {})
    if (remaining.length > 0) {
      await this.store.enqueueMessage(parentChatId, {
        ...waiting,
        id: undefined,
        content: this.buildReport(remaining),
        source: { kind: "report", chatIds: remaining },
      })
    }
    this.push({ sidebar: true, chatIds: [parentChatId] })
  }
}
