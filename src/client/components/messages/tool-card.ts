import { useToolPayload } from "./tool-payload-context"
import type { ProcessedToolCall } from "./types"

/**
 * What the cards for Kanna's own tool calls share: a chat's card
 * (ChatToolMessage) and a schedule's (ScheduleToolMessage). One box, one
 * width, and one way of reading the call, so the two cannot drift apart.
 */

/**
 * Sized like a user message (UserMessage's bubble): as wide as what it says,
 * up to the same share of the column, from the left edge where the agent's
 * rows sit. A card names one thing; stretched across the column its title and
 * its trailing detail end up a screen apart.
 *
 * The width goes on the outermost element, and the box inside fills it. On a
 * card with nothing around it the two go on the same element.
 */
export const TOOL_CARD_WIDTH_CLASS = "w-fit min-w-0 max-w-[85%] sm:max-w-[80%]"
export const TOOL_CARD_CLASS = "flex min-w-0 flex-col gap-0.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm"
/**
 * The line under a card's title. 26px in: under the title, past the 16px
 * glyph and the row's 10px gap. One line: the card names a thing, and the
 * thing itself is where the rest is read.
 */
export const TOOL_CARD_CAPTION_CLASS = "truncate pl-[26px] text-xs leading-4 text-muted-foreground"

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

/**
 * A result as an object. It is one already for a call recorded with its own
 * tool kind. An older record kept only what the provider was sent: the same
 * value as JSON, in a text block.
 */
function resultRecord(result: unknown): Record<string, unknown> | null {
  const direct = asRecord(result)
  if (direct) return direct
  const first = Array.isArray(result) ? text(asRecord(result[0])?.text) : text(result)
  if (!first) return null
  try {
    return asRecord(JSON.parse(first))
  } catch {
    return null
  }
}

/** A failed call's own words, which say what to do next. */
export function toolCardErrorText(result: unknown, fallback: string): string {
  if (Array.isArray(result)) {
    const joined = result.map((block) => asRecord(block)?.text ?? "").join("\n").trim()
    if (joined) return joined
  }
  return fallback
}

type CardToolCall = Extract<ProcessedToolCall, { toolKind: "chat" | "schedule" | "unknown_tool" }>

/**
 * A call's input and result, wherever they are kept. Inline for a call
 * recorded with its own tool kind. Fetched for one recorded before that kind
 * existed: it was filed as an unknown tool, with both left in the payload
 * sidecar.
 */
export function useToolCardPayload(message: CardToolCall) {
  const fetchedCall = useToolPayload(message.inputTrimmed ? message.id : undefined)
  const fetchedResult = useToolPayload(message.resultTrimmed ? message.resultEntryId : undefined)
  const fetchedInput = fetchedCall?.kind === "tool_call" ? asRecord(asRecord(fetchedCall.tool.input)?.payload) : null
  const rawResult = fetchedResult?.kind === "tool_result" ? fetchedResult.content : message.rawResult
  return {
    input: message.input.payload ?? fetchedInput ?? {},
    rawResult,
    result: message.isError ? null : resultRecord(rawResult),
  }
}
