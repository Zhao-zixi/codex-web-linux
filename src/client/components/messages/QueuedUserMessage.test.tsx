import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage } from "../../../shared/types"
import { QueuedUserMessage } from "./QueuedUserMessage"

describe("QueuedUserMessage", () => {
  test("renders queued message content left aligned inside the bubble", () => {
    const message: QueuedChatMessage = {
      id: "queued-1",
      content: "Queued follow-up",
      attachments: [],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued follow-up")
    expect(html).toContain("text-left")
    expect(html).not.toContain("text-right")
  })

  test("an attachment-only message still gets the Send now and Remove controls", () => {
    const message: QueuedChatMessage = {
      id: "queued-2",
      content: "",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "screenshot.png",
        absolutePath: "/tmp/screenshot.png",
        relativePath: "screenshot.png",
        contentUrl: "/media/screenshot.png",
        mimeType: "image/png",
        size: 1024,
      }],
      createdAt: Date.now(),
    }

    const html = renderToStaticMarkup(
      <QueuedUserMessage
        message={message}
        onRemove={() => undefined}
        onSendNow={() => undefined}
      />
    )

    expect(html).toContain("Queued")
    expect(html.match(/<button/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  const render = (message: QueuedChatMessage) => renderToStaticMarkup(
    <QueuedUserMessage message={message} onRemove={() => undefined} onSendNow={() => undefined} />
  )
  const report = "<system-message>\nSub-chat completed: [Audit](/chat/abc) (chat id abc)\n</system-message>\n\nall clear"

  test("Remove is always shown, for a typed message and for one that was sent to the chat", () => {
    const typed = render({ id: "q1", content: "mine", attachments: [], createdAt: 0 })
    const sent = render({ id: "q2", content: report, attachments: [], createdAt: 0, source: { kind: "report", chatIds: ["abc"] } })
    for (const html of [typed, sent]) {
      expect(html).toContain('aria-label="Remove from queue"')
      // Nothing waits for the pointer to appear.
      expect(html).not.toContain("opacity-0")
      expect(html).not.toContain("group-hover:opacity-100")
    }
  })

  test("a queued message nobody typed waits on the agent's side, turned around", () => {
    const typed = render({ id: "q1", content: "mine", attachments: [], createdAt: 0 })
    const sent = render({ id: "q2", content: report, attachments: [], createdAt: 0, source: { kind: "report", chatIds: ["abc"] } })

    expect(typed).toContain("items-end")
    expect(typed).not.toContain("items-start")
    expect(sent).toContain("items-start")
    // Still the dashed outline of something waiting.
    expect(sent).toContain("border-dashed")

    // Remove sits on the corner facing the middle of the column.
    expect(typed).toContain("left-0 -translate-x-[28%]")
    expect(sent).toContain("right-0 translate-x-[28%]")

    // Send now trails a typed message's text and leads this one's.
    const before = (html: string, first: string, second: string) => html.indexOf(first) >= 0 && html.indexOf(first) < html.indexOf(second)
    expect(before(typed, "mine", 'aria-label="Send now"')).toBe(true)
    expect(before(sent, 'aria-label="Send now"', "all clear")).toBe(true)

    // What it will show once delivered: its sender quoted.
    expect(sent).toContain(">Sub-chat<")
    // Each waits at the limit it will have once sent, so neither changes
    // height on the way in: 5 lines for this one, 25 for the user's own.
    expect(sent).toContain("max-height:5lh")
    expect(sent).not.toContain("max-height:25lh")
    expect(typed).toContain("max-height:25lh")
    expect(typed).not.toContain("max-height:5lh")
    expect(sent).not.toContain("chat id")
  })

  test("a queued report with nothing to read still says who it is from and can be sent or removed", () => {
    const html = render({
      id: "q3",
      content: "<system-message>\nSub-chat cancelled: [Audit](/chat/abc) (chat id abc)\n</system-message>",
      attachments: [],
      createdAt: 0,
      source: { kind: "report", chatIds: ["abc"] },
    })
    expect(html).toContain(">Sub-chat<")
    expect(html).toContain(">Queued<")
    expect(html).toContain('aria-label="Send now"')
    expect(html).toContain('aria-label="Remove from queue"')
  })

  test("the controls answer a press, and ease only what they change", () => {
    const typed = render({ id: "q8", content: "mine", attachments: [], createdAt: 0 })
    const sent = render({ id: "q9", content: report, attachments: [], createdAt: 0, source: { kind: "report", chatIds: ["abc"] } })
    for (const html of [typed, sent]) {
      const buttons = html.match(/<button[^>]*aria-label="(Send now|Remove from queue)"[^>]*>/g) ?? []
      expect(buttons.length).toBe(2)
      for (const button of buttons) {
        expect(button).toContain("active:scale-[0.95]")
        expect(button).toContain("transition-[color,background-color,scale]")
        // The shared button's `transition: all` would ease Remove's corner offset too.
        expect(button).not.toContain("transition-all")
        expect(button).toContain("motion-reduce:transition-none")
        // Each takes a press over more than the mark it draws.
        expect(button).toMatch(/before:-inset-1(\.5)? /)
      }
    }
  })

  test("a queued message has its quote and line over the dashed bubble, as it will once delivered", () => {
    const html = render({ id: "q6", content: report, attachments: [], createdAt: 0, source: { kind: "report", chatIds: ["abc"] } })
    // Quote, then the dashed bubble, then Remove on that bubble's corner.
    const quote = html.indexOf(">Sub-chat<")
    const bubble = html.indexOf("border-dashed")
    expect(quote).toBeGreaterThan(-1)
    expect(quote).toBeLessThan(bubble)
    expect(html.slice(bubble)).not.toContain("Sub-chat")
    expect(html.indexOf('aria-label="Remove from queue"')).toBeGreaterThan(bubble)
    // The same line as over a delivered bubble. Its 20px keep the quote, which
    // can reach over the corner Remove is on, well clear of Remove.
    expect(html).toContain("my-[3px] ml-[18px] h-[14px] w-[3px] rounded-full bg-border")
    expect(html).toContain("right-0 translate-x-[28%]")
  })

  test("a queued report on several sub-chats is a bubble for each, with one Remove and one Send now", () => {
    const html = render({
      id: "q7",
      content: [
        "<system-message>\nSub-chat completed: [Joke](/chat/one) (chat id one)\n</system-message>\n\nFirst answer",
        "<system-message>\nSub-chat failed: [Deploy](/chat/two) (chat id two)\n</system-message>\n\n---\n\ncredentials expired",
      ].join("\n\n"),
      attachments: [],
      createdAt: 0,
      source: { kind: "report", chatIds: ["one", "two"] },
    })
    const count = (text: string) => html.split(text).length - 1
    expect(count("border-dashed")).toBe(2)
    expect(count(">Sub-chat<")).toBe(2)
    expect(count('aria-label="Remove from queue"')).toBe(1)
    expect(count('aria-label="Send now"')).toBe(1)
    // Remove on the first bubble, Send now in the last.
    expect(html.indexOf('aria-label="Remove from queue"')).toBeLessThan(html.indexOf("credentials expired"))
    expect(html.indexOf('aria-label="Send now"')).toBeGreaterThan(html.indexOf("First answer"))
    // A line over each bubble.
    expect(count("h-[14px] w-[3px]")).toBe(2)
  })

  test("a queued interim reply is marked as one", () => {
    const html = render({
      id: "q4",
      content: '<system-message>\nSub-chat waiting_on_subagent: [Audit](/chat/abc) (chat id abc)\nNot its last word. Its turn ended, and it is still waiting on background work of its own (a subagent, a shell or a workflow). What follows is its reply so far. It reports again when its next turn ends.\n</system-message>\n\nhalfway',
      attachments: [],
      createdAt: 0,
      source: { kind: "report", chatIds: ["abc"] },
    })
    expect(html).toContain(">Not final<")
    expect(html).toContain("halfway")
    expect(html).not.toContain("Not its last word")
  })

  test("a queued adoption notice is the line, in the outline of something waiting, and can be sent or removed", () => {
    const html = render({
      id: "q5",
      content: '<system-message>\nSub-chat adopted: [Audit](/chat/abc) (chat id abc) now reports to the chat "Coordinator" (/chat/xyz), which adopted it. Its result will not arrive here. read_chat and wait_for_chats still reach it.\n</system-message>',
      attachments: [],
      createdAt: 0,
      source: { kind: "report", chatIds: ["abc"] },
    })
    expect(html).toContain(" was adopted by ")
    expect(html).toContain("border-dashed")
    expect(html).toContain("items-start")
    // The line is the news. It is not a quoted message, and not a placeholder.
    expect(html).not.toContain("Message from")
    expect(html).not.toContain("h-[14px] w-[3px]")
    expect(html).not.toContain(">Queued<")
    expect(html).toContain('aria-label="Send now"')
    expect(html).toContain('aria-label="Remove from queue"')
  })
})
