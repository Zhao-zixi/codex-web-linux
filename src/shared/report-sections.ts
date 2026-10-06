/**
 * A sub-chat report, taken apart into what each sub-chat said.
 *
 * A report is one message even when it covers several sub-chats (see
 * `buildReport` in the orchestrator). Each sub-chat gets a `<system-message>`
 * header that names it with `(chat id …)`, then its latest reply. From the
 * second one with something to say, a `---` rule comes first.
 *
 * A reader wants each answer beside the chat that gave it, so a client draws
 * one bubble per part. This is the only place that reads the header. It
 * takes three things from it and no prose: the chat id, the status word after
 * `Sub-chat`, and for an adopted chat the id of the chat that adopted it.
 */
export interface ReportSection {
  /** The sub-chat that said it. Null when no header names one of the report's chats. */
  chatId: string | null
  /** What it said. Empty only for an adoption notice, which has nothing under its header. */
  body: string
  /**
   * How the sub-chat stood when this was written: the word after `Sub-chat`
   * in its header (`completed`, `failed`, `waiting_on_subchats`, `adopted`…).
   * Null when there is no header to read it from.
   */
  status: string | null
  /** With `status: "adopted"`: the chat it reports to now, when the header names one. */
  adoptedByChatId?: string
}

const SYSTEM_MESSAGE_BLOCK = /<system-message>([\s\S]*?)<\/system-message>/g
const CHAT_ID = /\(chat id ([^)\s]+)\)/
const STATUS = /^\s*Sub-chat ([a-z_]+):/
/** The adopter's link, by what follows it: its title comes first and can hold anything. */
const ADOPTER = /\(\/chat\/([^)\s]+)\), which adopted it/
/** The rule `buildReport` puts between two sub-chats' words. */
const LEADING_RULE = /^---[ \t]*\n+/

/** The status a header carries when its chat was adopted away and no result is coming. */
export const ADOPTED_REPORT_STATUS = "adopted"

/**
 * Whether a report was written while its sub-chat, or work under it, was
 * still going: the reply is what it had to say so far, and another report
 * follows. The orchestrator's `isStillGoing`, on the word it put in the header.
 */
export function isInterimReportStatus(status: string | null): boolean {
  return status === "running" || status === "waiting_on_subagent" || status === "waiting_on_subchats"
}

/**
 * Split a report into the parts a reader is shown, in order. A sub-chat that
 * ended without saying anything has no part, with one exception: one that was
 * adopted by another chat. That header is the whole of the news, and without
 * a part the reader waiting on that sub-chat would be told nothing.
 *
 * `chatIds` is the report's own list (`MessageSource.chatIds`). A block that
 * names any other chat is text a sub-chat quoted, not a header, so what
 * follows it stays with the part it was in.
 */
export function splitReportSections(content: string, chatIds: readonly string[]): ReportSection[] {
  const known = new Set(chatIds)
  const parts: ReportSection[] = []
  let cursor = 0
  let current: ReportSection = { chatId: null, body: "", status: null }
  // Whether a part before this one had words. Only then was a rule put ahead
  // of the next one's, so only then is a leading rule not the sub-chat's own.
  let shown = false

  const take = (until: number) => {
    current.body += content.slice(cursor, until)
  }
  const close = () => {
    let body = current.body.trim()
    if (shown) body = body.replace(LEADING_RULE, "")
    if (body) shown = true
    if (body || current.status === ADOPTED_REPORT_STATUS) parts.push({ ...current, body })
  }

  for (const block of content.matchAll(SYSTEM_MESSAGE_BLOCK)) {
    take(block.index)
    cursor = block.index + block[0].length
    const header = block[1] ?? ""
    const chatId = CHAT_ID.exec(header)?.[1]
    if (!chatId || !known.has(chatId)) continue
    close()
    const status = STATUS.exec(header)?.[1] ?? null
    const adoptedByChatId = status === ADOPTED_REPORT_STATUS ? ADOPTER.exec(header)?.[1] : undefined
    current = { chatId, body: "", status, ...(adoptedByChatId ? { adoptedByChatId } : {}) }
  }
  take(content.length)
  close()

  return parts
}
