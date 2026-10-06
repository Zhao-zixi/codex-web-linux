/**
 * What a message sent from the graph view (`/graph/:chatId`) tells its agent
 * beyond what the user typed: hand the work to other chats instead of doing it.
 *
 * It goes the way a sub-chat report's header does (`buildReport` in the
 * orchestrator): a `<system-message>` block stored with the message. The agent
 * reads it, and every place that shows a message leaves it out
 * (`stripSystemMessages`): the bubble, the queue, previews, the outline. Being
 * part of the stored text, it is in the transcript an export, a fork and a
 * harness hand-off carry, with nothing else to keep in step.
 *
 * The line about adopting is what makes a hand-off to a chat the agent did
 * not start count: without `adopt` on `send_message` that chat sends nothing
 * back and has no parent link, so it never appears in the graph the message
 * was sent from.
 */
export const DELEGATION_INSTRUCTIONS = `The user is working in a task delegation environment. Do not work on this directly. Instead, use the Kanna MCP to spawn chats that report back to you.

- decide if the task should be sent to an existing thread
  - if you send it to an existing thread, adopt it (adopt: true on send_message) so it reports back to you and shows in the graph
- decide if the message you send should steer or enqueue
- decide if it should go in a new thread

use the Kanna mcp to do all these things, and act accordingly`

export const DELEGATION_BLOCK = `<system-message>\n${DELEGATION_INSTRUCTIONS}\n</system-message>`

/**
 * The message as it is sent from the graph view: what was typed, then the
 * block.
 *
 * After, never before: Claude and Pi only expand a skill when the message
 * starts with its `/name`. A message that already ends with the block (a
 * failed send put back in the composer and sent again) is left as it is.
 */
export function attachDelegationBlock(content: string): string {
  const trimmed = content.trim()
  if (trimmed.endsWith(DELEGATION_BLOCK)) return trimmed
  return trimmed.length > 0 ? `${trimmed}\n\n${DELEGATION_BLOCK}` : DELEGATION_BLOCK
}
