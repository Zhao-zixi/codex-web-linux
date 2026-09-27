import type {
  AgentProvider,
  AskUserQuestionItem,
  NormalizedToolCall,
  TodoItem,
  TranscriptEntry,
} from "../shared/types"

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A transcript entry before the backend stamps it with an id and a time. */
export type EntryDraft = DistributiveOmit<TranscriptEntry, "_id" | "createdAt">

/** How a step changes one file in the project. Returning null deletes it. */
export interface DemoFileWrite {
  path: string
  apply: (current: string | null) => string | null
}

export interface DemoStep {
  /** Pause before this step lands when the turn plays live. */
  delayMs: number
  entries: EntryDraft[]
  writes?: DemoFileWrite[]
  /**
   * The step asked the user a question. The turn stops here until
   * `chat.respondTool` arrives, then plays `continueWith(firstAnswer)`.
   */
  question?: {
    toolId: string
    preview: string
    continueWith: (answer: string) => DemoStep[]
  }
}

export interface DemoTurn {
  prompt: string
  provider: AgentProvider
  model: string
  steps: DemoStep[]
}

const CLAUDE_TOOLS = ["Task", "Bash", "Glob", "Grep", "Read", "Edit", "Write", "TodoWrite", "WebSearch", "AskUserQuestion"]
const CODEX_TOOLS = ["shell", "apply_patch", "update_plan", "web_search"]
const CURSOR_TOOLS = ["read_file", "edit_file", "run_terminal_cmd", "grep_search", "file_search"]

let toolCounter = 0

function nextToolId() {
  toolCounter += 1
  return `toolu_demo_${toolCounter.toString().padStart(4, "0")}`
}

function toolNames(provider: AgentProvider) {
  if (provider === "codex") return CODEX_TOOLS
  if (provider === "cursor") return CURSOR_TOOLS
  return CLAUDE_TOOLS
}

function numberLines(content: string) {
  return content
    .replace(/\n$/, "")
    .split("\n")
    .map((line, index) => `${index + 1}\t${line}`)
    .join("\n")
}

/**
 * Builds a turn as the steps a provider would stream. Each tool is two steps,
 * the call and then its result, so a live turn shows the row spinning before
 * it completes, as it does with a real agent.
 */
export class TurnScript {
  readonly steps: DemoStep[] = []

  constructor(readonly provider: AgentProvider, readonly model: string) {}

  init() {
    this.steps.push({
      delayMs: 500,
      entries: [{
        kind: "system_init",
        provider: this.provider,
        model: this.model,
        tools: toolNames(this.provider),
        agents: [],
        slashCommands: [],
        mcpServers: [],
      }],
    })
    return this
  }

  say(text: string, delayMs = 1100) {
    this.steps.push({ delayMs, entries: [{ kind: "assistant_text", text }] })
    return this
  }

  private tool(tool: NormalizedToolCall, result: string, options?: { callDelayMs?: number; resultDelayMs?: number; writes?: DemoFileWrite[] }) {
    this.steps.push({ delayMs: options?.callDelayMs ?? 700, entries: [{ kind: "tool_call", tool }] })
    this.steps.push({
      delayMs: options?.resultDelayMs ?? 450,
      entries: [{ kind: "tool_result", toolId: tool.toolId, content: result }],
      writes: options?.writes,
    })
    return this
  }

  read(path: string, content: string, absolutePath: string) {
    return this.tool(
      { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: nextToolId(), input: { filePath: absolutePath } },
      numberLines(content),
      { resultDelayMs: 300 },
    )
  }

  grep(pattern: string, output: string) {
    return this.tool(
      { kind: "tool", toolKind: "grep", toolName: "Grep", toolId: nextToolId(), input: { pattern, outputMode: "content" } },
      output,
      { resultDelayMs: 350 },
    )
  }

  glob(pattern: string, output: string) {
    return this.tool(
      { kind: "tool", toolKind: "glob", toolName: "Glob", toolId: nextToolId(), input: { pattern } },
      output,
      { resultDelayMs: 250 },
    )
  }

  bash(command: string, description: string, output: string, runMs = 1600) {
    return this.tool(
      { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: nextToolId(), input: { command, description } },
      output,
      { resultDelayMs: runMs },
    )
  }

  edit(path: string, absolutePath: string, oldString: string, newString: string) {
    return this.tool(
      { kind: "tool", toolKind: "edit_file", toolName: "Edit", toolId: nextToolId(), input: { filePath: absolutePath, oldString, newString } },
      `The file ${absolutePath} has been updated successfully.`,
      {
        callDelayMs: 1200,
        writes: [{
          path,
          apply: (current) => {
            if (current === null || !current.includes(oldString)) return current
            return current.replace(oldString, newString)
          },
        }],
      },
    )
  }

  write(path: string, absolutePath: string, content: string) {
    return this.tool(
      { kind: "tool", toolKind: "write_file", toolName: "Write", toolId: nextToolId(), input: { filePath: absolutePath, content } },
      `File created successfully at: ${absolutePath}`,
      { callDelayMs: 1400, writes: [{ path, apply: () => content }] },
    )
  }

  todos(todos: TodoItem[]) {
    return this.tool(
      { kind: "tool", toolKind: "todo_write", toolName: "TodoWrite", toolId: nextToolId(), input: { todos } },
      "Todos have been modified successfully.",
      { callDelayMs: 600, resultDelayMs: 150 },
    )
  }

  ask(question: AskUserQuestionItem, continueWith: (answer: string) => DemoStep[]) {
    const toolId = nextToolId()
    this.steps.push({
      delayMs: 900,
      entries: [{
        kind: "tool_call",
        tool: { kind: "tool", toolKind: "ask_user_question", toolName: "AskUserQuestion", toolId, input: { questions: [question] } },
      }],
      question: { toolId, preview: question.question, continueWith },
    })
    return this
  }

  /** Closes the turn the way providers do: a usage report, then the result. */
  finish(result: string, usage: { usedTokens: number; maxTokens: number }) {
    const durationMs = this.steps.reduce((total, step) => total + step.delayMs, 0)
    this.steps.push({
      delayMs: 400,
      entries: [
        {
          kind: "context_window_updated",
          usage: { usedTokens: usage.usedTokens, maxTokens: usage.maxTokens, compactsAutomatically: true },
        },
        { kind: "result", subtype: "success", isError: false, durationMs, result },
      ],
    })
    return this
  }
}

export function todo(content: string, activeForm: string, status: TodoItem["status"]): TodoItem {
  return { content, activeForm, status }
}
