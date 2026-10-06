import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { ChatReplyQuote, replyCaption } from "./ChatToolMessage"
import { messageNamingParent, ParentChatLink } from "./ParentChatLink"
import { SourcedMessage } from "./SourcedMessage"

const at = new Date(0).toISOString()
const prompt = (id: string, extra: Partial<Extract<HydratedTranscriptMessage, { kind: "user_prompt" }>> = {}): HydratedTranscriptMessage => (
  { id, kind: "user_prompt", content: "audit the parser", timestamp: at, ...extra }
)

describe("messageNamingParent", () => {
  const opening = prompt("u1", { source: { kind: "agent", chatId: "parent" } })

  test("is the opening message when the parent sent it and the transcript starts here", () => {
    expect(messageNamingParent([opening, prompt("u2")], "parent", false)).toBe("u1")
    // Rows that are not prompts may come first.
    expect(messageNamingParent([{ id: "t", kind: "assistant_text", text: "hi", timestamp: at }, opening], "parent", false)).toBe("u1")
  })

  test("is nothing while older messages are still to load: the first one held is not the opening", () => {
    expect(messageNamingParent([opening], "parent", true)).toBeNull()
  })

  test("is nothing for a chat handed to another parent since: its opening message names someone else", () => {
    expect(messageNamingParent([opening], "adopter", false)).toBeNull()
  })

  test("is nothing when the opening message is not from the parent's agent", () => {
    expect(messageNamingParent([prompt("u1")], "parent", false)).toBeNull()
    expect(messageNamingParent([prompt("u1", { source: { kind: "schedule", scheduleId: "s" } })], "parent", false)).toBeNull()
    // Only the opening message counts. A later one from the parent is not at the top.
    expect(messageNamingParent([prompt("u1"), opening], "parent", false)).toBeNull()
    expect(messageNamingParent([], "parent", false)).toBeNull()
    expect(messageNamingParent([opening], null, false)).toBeNull()
  })
})

describe("the link between two chats", () => {
  const quoteOf = (html: string) => html.slice(html.indexOf("not-prose"), html.indexOf("</p>", html.indexOf("not-prose")))

  test("is one quote from both ends: on the message a sub-chat opens with, and on the report that comes back", () => {
    const inChild = renderToStaticMarkup(<SourcedMessage content="audit the parser" source={{ kind: "agent", chatId: "parent" }} />)
    const inParent = renderToStaticMarkup(<SourcedMessage content="all clear" source={{ kind: "report", chatIds: ["child"] }} />)
    for (const html of [inChild, inParent]) expect(html).toContain(">Replied to<")
    // The same box and the same line under the title. Only the name the
    // sidebar could not supply differs here.
    expect(quoteOf(inChild).replace("Another agent", "Sub-chat")).toBe(quoteOf(inParent))
    expect(inChild).not.toContain("Sent this message")
    expect(inParent).not.toContain("Reported back")
  })

  test("what the quoted chat was told follows the label, when it is known", () => {
    expect(renderToStaticMarkup(<ChatReplyQuote chatId="c" title="Sub-chat" excerpt="audit the parser" />)).toContain(">Replied to · audit the parser<")
    expect(renderToStaticMarkup(<ChatReplyQuote chatId="c" title="Sub-chat" excerpt={null} />)).toContain(">Replied to<")
  })
})

describe("replyCaption", () => {
  const thread = { archived: false, projectId: "p1", projectLabel: { text: "site/main" } }

  test("is the label alone when nothing about the chat is unusual", () => {
    expect(replyCaption(thread, "p1")).toBe("Replied to")
    // A chat the sidebar cannot describe, and a reader whose project is not known.
    expect(replyCaption(null, "p1")).toBe("Replied to")
    expect(replyCaption(thread, null)).toBe("Replied to")
  })

  test("names the chat's project when it is another one, and says when it is archived", () => {
    expect(replyCaption(thread, "p2")).toBe("Replied to · site/main")
    expect(replyCaption({ ...thread, archived: true }, "p1")).toBe("Replied to · Archived")
  })

  test("what the chat was told comes last, where a long one is cut", () => {
    expect(replyCaption(thread, "p1", "tell me a joke")).toBe("Replied to · tell me a joke")
    expect(replyCaption({ ...thread, archived: true }, "p2", "tell me a joke")).toBe("Replied to · site/main · Archived · tell me a joke")
  })

  test("a reply sent on the way says it is not final, ahead of the excerpt", () => {
    expect(replyCaption(thread, "p1", null, true)).toBe("Replied to · Not final")
    expect(replyCaption(thread, "p1", "tell me a joke", true)).toBe("Replied to · Not final · tell me a joke")
    expect(replyCaption(thread, "p1", "tell me a joke", false)).toBe("Replied to · tell me a joke")
  })
})

describe("ParentChatLink", () => {
  // The sidebar has said nothing yet in a static render, which is the state a
  // chat opened before the first snapshot is in.
  test("draws nothing until the sidebar has loaded, rather than calling the parent deleted", () => {
    expect(renderToStaticMarkup(<ParentChatLink parentChatId="parent" />)).toBe("")
  })
})
