import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAttributionInstructions } from "./attribution"

/**
 * Everything Kanna tells a harness that holds for the whole session. It goes
 * in the system prompt where the provider has an append hook (claude, pi,
 * codex), so it is cached there instead of being re-sent in every user turn.
 * Only notices that change turn to turn (skills, concurrent agents, steer)
 * belong on the user-text path. See attribution.ts for the per-provider hooks.
 */
export function buildKannaSystemInstructions(agentId: string): string {
  return [buildKannaAttributionInstructions(agentId), KANNA_CHAT_LINK_INSTRUCTIONS].join("\n\n")
}

/** Wrapped for the providers that have no system-prompt append hook (cursor, grok). */
export function buildKannaSystemMessage(agentId: string): string {
  return `<system-message>${buildKannaSystemInstructions(agentId)}</system-message>`
}
