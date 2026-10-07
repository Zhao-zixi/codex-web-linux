import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { QueuedChatMessage } from "../../../shared/types"
import { ClampedMessageText, CLAMP_LINES, clampTransitionMs, FOLD_SURFACE_ATTRIBUTE, isFoldClick } from "./ClampedMessageText"
import { QueuedUserMessage } from "./QueuedUserMessage"
import { SourcedMessage } from "./SourcedMessage"
import { UserMessage } from "./UserMessage"

test("what the user typed gets 25 lines, and what was sent to the chat gets 5", () => {
  expect(CLAMP_LINES).toEqual({ typed: 25, sent: 5 })
})

test("the text starts clamped at the limit it is given, with no control until it is known to overflow", () => {
  const html = renderToStaticMarkup(<ClampedMessageText text={"a short prompt"} lines={CLAMP_LINES.sent} />)
  expect(html).toContain("a short prompt")
  // In lines of the text's own type, whatever the number.
  expect(html).toContain('class="overflow-hidden" style="max-height:5lh"')
  expect(renderToStaticMarkup(<ClampedMessageText text={"a short prompt"} lines={CLAMP_LINES.typed} />)).toContain('style="max-height:25lh"')
  // Nothing is measured without a layout, so nothing claims there is more.
  expect(html).not.toContain("Show more")
  expect(html).not.toContain("mask-image")
})

test("the text is a box of its own inside the clamp, so its real height can be watched", () => {
  const html = renderToStaticMarkup(<ClampedMessageText text={"one\n\ntwo"} lines={CLAMP_LINES.sent} />)
  // Clamp, then the text's own box, then the paragraphs as that box's
  // children, where `first:mt-0` lands on the first.
  expect(html).toMatch(/<div id="[^"]+" class="overflow-hidden" style="max-height:5lh"><div class="[^"]*whitespace-pre-line[^"]*"><p /)
})

describe("clampTransitionMs", () => {
  const press = { from: 120, to: 420, reducedMotion: false, byKeyboard: false, startsAboveView: false }

  test("opening takes a beat longer than closing, and both stay under 300ms", () => {
    const opening = clampTransitionMs({ ...press, expanding: true })
    const closing = clampTransitionMs({ ...press, from: 420, to: 120, expanding: false })
    expect(opening).toBe(200)
    expect(closing).toBe(160)
  })

  // A typed message's 25 lines are 600px before it opens, so a long one often
  // has further to go than can be followed. It is then a cut, start to finish:
  // the answer is a duration or nothing, never part of a move.
  test("a typed message opening from its 25 lines eases a short way and cuts a long one", () => {
    const collapsed = 25 * 24
    expect(clampTransitionMs({ ...press, from: collapsed, to: collapsed + 240, expanding: true })).toBe(200)
    expect(clampTransitionMs({ ...press, from: collapsed, to: collapsed + 1200, expanding: true })).toBeNull()
    expect(clampTransitionMs({ ...press, from: collapsed + 1200, to: collapsed, expanding: false })).toBeNull()
  })

  test("a move too long to follow is not eased", () => {
    expect(clampTransitionMs({ ...press, to: 120 + 800, expanding: true })).toBe(200)
    expect(clampTransitionMs({ ...press, to: 120 + 801, expanding: true })).toBeNull()
    expect(clampTransitionMs({ ...press, from: 3000, to: 120, expanding: false })).toBeNull()
  })

  test("nor is one made by a key, or for a reader who asked for less motion", () => {
    expect(clampTransitionMs({ ...press, expanding: true, byKeyboard: true })).toBeNull()
    expect(clampTransitionMs({ ...press, expanding: true, reducedMotion: true })).toBeNull()
  })

  test("a collapse that starts above the view is a cut, because the page is about to be moved to it", () => {
    expect(clampTransitionMs({ ...press, from: 420, to: 120, expanding: false, startsAboveView: true })).toBeNull()
    // Opening has nowhere to be moved to.
    expect(clampTransitionMs({ ...press, expanding: true, startsAboveView: true })).toBe(200)
  })

  test("nothing eases when there is nowhere to go, or no way to know where", () => {
    expect(clampTransitionMs({ ...press, to: 120, expanding: true })).toBeNull()
    expect(clampTransitionMs({ ...press, to: Number.NaN, expanding: false })).toBeNull()
  })
})

describe("isFoldClick", () => {
  // A plain click on the bubble's text or padding.
  const click = { button: 0, clicks: 1, modified: false, movedPx: 0, selecting: false, onOwnClick: false, handled: false }

  test("a plain click on a folded message opens it", () => {
    expect(isFoldClick(click)).toBe(true)
    // A hand is not a tripod: a few pixels between down and up is still a click.
    expect(isFoldClick({ ...click, movedPx: 4 })).toBe(true)
  })

  test("a drag is a selection being made, not a click", () => {
    expect(isFoldClick({ ...click, movedPx: 5 })).toBe(false)
    expect(isFoldClick({ ...click, movedPx: 120 })).toBe(false)
  })

  test("a click with text selected finishes or clears the selection and does nothing else", () => {
    expect(isFoldClick({ ...click, selecting: true })).toBe(false)
    // Even one that did not move: the click that lets a selection go.
    expect(isFoldClick({ ...click, selecting: true, movedPx: 0 })).toBe(false)
  })

  test("a second or third click in a row is selecting a word or a paragraph", () => {
    expect(isFoldClick({ ...click, clicks: 2 })).toBe(false)
    expect(isFoldClick({ ...click, clicks: 3 })).toBe(false)
  })

  test("a right, middle or modified click belongs to the menu or the browser", () => {
    expect(isFoldClick({ ...click, button: 2 })).toBe(false)
    expect(isFoldClick({ ...click, button: 1 })).toBe(false)
    expect(isFoldClick({ ...click, modified: true })).toBe(false)
  })

  test("a link, a button or an image inside the message keeps its own click", () => {
    expect(isFoldClick({ ...click, onOwnClick: true })).toBe(false)
    expect(isFoldClick({ ...click, handled: true })).toBe(false)
  })
})

describe("the surface a folded message opens from", () => {
  const surfaces = (html: string) => html.split(`${FOLD_SURFACE_ATTRIBUTE}=""`).length - 1
  const queued = (message: Partial<QueuedChatMessage>) => renderToStaticMarkup(
    <QueuedUserMessage
      message={{ id: "q", content: "hello", attachments: [], createdAt: 0, ...message }}
      onRemove={() => undefined}
      onSendNow={() => undefined}
    />,
  )
  const report = "<system-message>\nSub-chat completed: [Audit](/chat/abc) (chat id abc)\n</system-message>\n\nall clear"

  test("is the bubble, for a typed message and for one sent to the chat, delivered or queued", () => {
    const forms = [
      renderToStaticMarkup(<UserMessage content="hello" />),
      renderToStaticMarkup(<SourcedMessage content="hello" source={{ kind: "agent", chatId: "parent" }} />),
      queued({}),
      queued({ content: report, source: { kind: "report", chatIds: ["abc"] } }),
    ]
    for (const html of forms) {
      expect(surfaces(html)).toBe(1)
      // On the element that draws the bubble's outline, so its padding counts.
      expect(html).toMatch(/data-fold-surface="" class="[^"]*rounded-2xl border/)
    }
  })

  test("leaves out what sits around the bubble: the quote over it and a queued message's Remove", () => {
    const html = queued({ content: report, source: { kind: "report", chatIds: ["abc"] } })
    const surface = html.indexOf(`${FOLD_SURFACE_ATTRIBUTE}=""`)
    // The quote comes before the bubble opens, and Remove after it closes.
    expect(html.indexOf(">Sub-chat<")).toBeGreaterThan(-1)
    expect(html.indexOf(">Sub-chat<")).toBeLessThan(surface)
    const remove = html.indexOf('aria-label="Remove from queue"')
    // From inside the bubble's own tag to Remove, one more box closes than
    // opens: the bubble itself. So Remove is outside it.
    const upToRemove = html.slice(surface, remove)
    expect(upToRemove.split("</div>").length).toBe(upToRemove.split("<div").length + 1)
  })

  test("is not a second control: nothing on the bubble takes focus or announces itself", () => {
    const html = renderToStaticMarkup(<UserMessage content="hello" />)
    const bubble = html.slice(html.indexOf(`${FOLD_SURFACE_ATTRIBUTE}=""`), html.indexOf(">", html.indexOf(`${FOLD_SURFACE_ATTRIBUTE}=""`)))
    expect(bubble).not.toContain("role=")
    expect(bubble).not.toContain("tabindex")
  })
})
