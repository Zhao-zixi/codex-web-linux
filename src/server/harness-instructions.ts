import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAttributionInstructions } from "./attribution"

/**
 * How to use the chat tools in `kanna-orchestration-tools.ts`. The tool
 * descriptions say what each one does; this says which to reach for, which
 * the descriptions cannot do one tool at a time.
 */
export const KANNA_ORCHESTRATION_INSTRUCTIONS = [
  "# Kanna chats",
  "",
  "The `kanna` tools let you do what the user can do in Kanna: start chats, message them, read them, stop them, and schedule messages. Tool names may carry a prefix such as `mcp__kanna__`.",
  "",
  "- A sub-chat is a chat you start with `create_chat`. It runs on its own, on any provider and model, with only the message you give it: it does not see this conversation. Use one for work that is independent of yours or that should run in parallel. For small same-model help, your own subagent tool is cheaper.",
  "- Sub-chats are asynchronous. `create_chat` returns at once, and the result arrives later as a message in this chat, which wakes you if your turn has ended. So you can start several, finish your turn, and be called back.",
  "- Call `wait_for_chats` only when your next step needs the answer. A wait that times out does not stop the chat; wait again, read it with `read_chat`, or carry on and let the result come as a message.",
  "- Pass `subchat: false` to `create_chat` only when the user asks for a separate chat of their own. It reports nothing back.",
  "- `fork_chat` copies a conversation, context included. `create_chat` starts empty.",
  "- `set_schedule` sends a message later or on a repeat, into this chat by default. Use it to check on something in a while instead of sleeping.",
  "- Stopping this chat stops its sub-chats. Stop one yourself with `cancel_chat` when it is no longer needed.",
].join("\n")

/**
 * Everything Kanna tells a harness that holds for the whole session. It goes
 * in the system prompt where the provider has an append hook (claude, pi,
 * codex), so it is cached there instead of being re-sent in every user turn.
 * Only notices that change turn to turn (skills, concurrent agents, steer)
 * belong on the user-text path. See attribution.ts for the per-provider hooks.
 *
 * `tools: false` is for a harness that is not handed the Kanna tools, which
 * must not be told to call them.
 */
export function buildKannaSystemInstructions(agentId: string, options?: { tools?: boolean }): string {
  return [
    buildKannaAttributionInstructions(agentId),
    KANNA_CHAT_LINK_INSTRUCTIONS,
    ...(options?.tools === false ? [] : [KANNA_ORCHESTRATION_INSTRUCTIONS]),
  ].join("\n\n")
}

/** Wrapped for the providers that have no system-prompt append hook (cursor, grok). */
export function buildKannaSystemMessage(agentId: string, options?: { tools?: boolean }): string {
  return `<system-message>${buildKannaSystemInstructions(agentId, options)}</system-message>`
}
