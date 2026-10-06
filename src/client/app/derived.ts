import type { HydratedTranscriptMessage } from "../../shared/types"
import type { ProcessedToolCall } from "../components/messages/types"

export const SPECIAL_TOOL_NAMES = ["AskUserQuestion", "ExitPlanMode", "TodoWrite"] as const
const RESOLVED_TOOL_NAMES = new Set<string>(["TodoWrite"])

function findLatestUnresolvedToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    const matches = toolCall.toolName === toolName
      || (toolName === "AskUserQuestion" && toolCall.toolKind === "ask_user_question")
    if (matches && !toolCall.result) {
      return toolCall.id
    }
  }
  return null
}

function findLatestToolId(messages: HydratedTranscriptMessage[], toolName: string): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.kind !== "tool") continue
    const toolCall = message as ProcessedToolCall
    if (toolCall.toolName === toolName) {
      return toolCall.id
    }
  }
  return null
}

export function getLatestToolIds(messages: HydratedTranscriptMessage[]) {
  const ids: Record<string, string | null> = {}
  for (const toolName of SPECIAL_TOOL_NAMES) {
    ids[toolName] = RESOLVED_TOOL_NAMES.has(toolName)
      ? findLatestToolId(messages, toolName)
      : findLatestUnresolvedToolId(messages, toolName)
  }
  return ids
}

export function isProcessingStatus(status?: string) {
  return status === "starting" || status === "running" || status === "waiting_for_user"
}

/**
 * The chat has no turn of its own in flight, so a send starts one at once and
 * the "starting" shown meanwhile is the client's to supply. A chat waiting on
 * a subagent is one of these: the work it waits on is not its turn.
 */
export function hasNoTurnStatus(status?: string) {
  return status === "idle" || status === "waiting_on_subagent"
}

export const canCancelStatus = isProcessingStatus
