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
  const quoteOf = (html: string) => html.slice(html.indexOf("not-prose"), html.indexOf("my-[3px] ml-[18px]"))

  test("is one quote from both ends: on the message a sub-chat opens with, and on the report that comes back", () => {
    const inChild = renderToStaticMarkup(<SourcedMessage content="audit the parser" source={{ kind: "agent", chatId: "parent" }} />)
    const inParent = renderToStaticMarkup(<SourcedMessage content="all clear" source={{ kind: "report", chatIds: ["child"] }} />)
    // The same box with the same row in it. Only the name the sidebar could
    // not supply differs here.
    expect(quoteOf(inChild)).toContain(">Another agent<")
    expect(quoteOf(inChild).replace("Another agent", "Sub-chat")).toBe(quoteOf(inParent))
    // Neither says in words what its place over the message already does.
    for (const html of [inChild, inParent]) {
      expect(html).not.toContain("Replied to")
      expect(html).not.toContain("Sent this message")
      expect(html).not.toContain("Reported back")
    }
  })

  test("what the quoted chat was told is the line under its title, when it is known, and there is no line when it is not", () => {
    const caption = "truncate pl-[26px] text-xs leading-4 text-muted-foreground"
    const told = renderToStaticMarkup(<ChatReplyQuote chatId="c" title="Sub-chat" excerpt="audit the parser" />)
    expect(told).toContain(`<p class="${caption}">audit the parser</p>`)
    const bare = renderToStaticMarkup(<ChatReplyQuote chatId="c" title="Sub-chat" excerpt={null} />)
    expect(bare).not.toContain(caption)
    expect(bare).not.toContain("<p ")
  })

  test("the standalone quote of a parent is read out as one", () => {
    expect(renderToStaticMarkup(<ChatReplyQuote chatId="c" title="Parent chat" said="Parent chat:" />)).toContain('<span class="sr-only">Parent chat: </span>')
  })
})

describe("replyCaption", () => {
  const thread = { archived: false, projectId: "p1", projectLabel: { text: "site/main" } }

  test("is nothing when nothing about the chat is unusual: the quote is one line", () => {
    expect(replyCaption(thread, "p1")).toBeNull()
    // A chat the sidebar cannot describe, and a reader whose project is not known.
    expect(replyCaption(null, "p1")).toBeNull()
    expect(replyCaption(thread, null)).toBeNull()
    expect(replyCaption(thread, "p1", "")).toBeNull()
  })

  test("names the chat's project when it is another one, and says when it is archived", () => {
    expect(replyCaption(thread, "p2")).toBe("site/main")
    expect(replyCaption({ ...thread, archived: true }, "p1")).toBe("Archived")
  })

  test("what the chat was told comes last, where a long one is cut", () => {
    expect(replyCaption(thread, "p1", "tell me a joke")).toBe("tell me a joke")
    expect(replyCaption({ ...thread, archived: true }, "p2", "tell me a joke")).toBe("site/main · Archived · tell me a joke")
  })

  test("a reply sent on the way says it is not final, ahead of the excerpt", () => {
    expect(replyCaption(thread, "p1", null, true)).toBe("Not final")
    expect(replyCaption(thread, "p1", "tell me a joke", true)).toBe("Not final · tell me a joke")
    expect(replyCaption(thread, "p1", "tell me a joke", false)).toBe("tell me a joke")
  })

  test("never says in words that the message is a reply", () => {
    for (const caption of [
      replyCaption(thread, "p2", "tell me a joke", true),
      replyCaption({ ...thread, archived: true }, "p1"),
      replyCaption(thread, "p1", "tell me a joke"),
    ]) expect(caption).not.toContain("Replied to")
  })
})

describe("ParentChatLink", () => {
  // The sidebar has said nothing yet in a static render, which is the state a
  // chat opened before the first snapshot is in.
  test("draws nothing until the sidebar has loaded, rather than calling the parent deleted", () => {
    expect(renderToStaticMarkup(<ParentChatLink parentChatId="parent" />)).toBe("")
  })
})
