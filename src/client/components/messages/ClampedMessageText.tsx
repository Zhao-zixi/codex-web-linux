import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/utils"
import { TranscriptMarkdown } from "./shared"

/**
 * The text of a message sent to the agent, held to a number of lines until
 * asked for. Every such message uses this: what the user typed, what another
 * agent, a sub-chat or a schedule sent, and each of those while it waits in
 * the queue. A long prompt is a wall between one answer and the next, and the
 * reader of a transcript is there for the answers. Those are never clamped.
 *
 * The limit is a height, not a line clamp: the text is markdown, and a clamp
 * counts lines inside one block. The last line fades out instead of being cut,
 * because a heading or a list does not land on the paragraph's line grid, and
 * a hard edge there slices through letters. The fade is a mask on the text,
 * not a gradient laid over it, so it has no colour of its own to match to
 * whatever is behind: a filled bubble, a dashed outline, either theme.
 */

/**
 * How many lines of a message show before Show more, by who sent it. The two
 * numbers live here and nowhere else.
 *
 * What the user typed gets room: they wrote it, they may be checking it, and
 * most of what they write fits. What was sent to the chat for the agent (a
 * report, another agent's message, an automation) gets a glance: it runs
 * long, and the reader did not write it and was not waiting on its words. A
 * message waiting in the queue has the limit it will have once sent, so it
 * does not change height on the way in.
 */
export const CLAMP_LINES = { typed: 25, sent: 5 } as const

/** A prompt keeps the line breaks it was typed with. */
const TEXT_CLASS = "[&_p]:whitespace-pre-line"

/** Opening is the reader's request being met, so it gets a beat. Closing is them done with it. */
const EXPAND_MS = 200
const COLLAPSE_MS = 160
/** `--ease-snappy`, the app's curve, as a value: this one runs from script. */
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
/** About a screen. Past it the text is on its way off the page before the eye has caught the move. */
const MAX_EASED_DISTANCE_PX = 800

/**
 * How long the text takes to open or close, or null to simply be there.
 *
 * It eases because everything under it moves, and a row that jumps a few
 * hundred pixels with nothing in between reads as the page reloading. Height
 * is the property because there is no other: the rows below have to be
 * pushed, which a transform does not do.
 *
 * It does not ease when the move is too long to follow, when the reader asked
 * for less motion, or when a key did it: someone driving by keyboard is
 * working through controls, and each should answer at once. Nor on a collapse
 * that starts above the view, which ends with the page being moved to the
 * message. A slide and then a jump is worse than the jump.
 */
export function clampTransitionMs({ expanding, from, to, reducedMotion, byKeyboard, startsAboveView }: {
  expanding: boolean
  from: number
  to: number
  reducedMotion: boolean
  byKeyboard: boolean
  startsAboveView: boolean
}): number | null {
  if (reducedMotion || byKeyboard) return null
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) return null
  if (Math.abs(to - from) > MAX_EASED_DISTANCE_PX) return null
  if (!expanding && startsAboveView) return null
  return expanding ? EXPAND_MS : COLLAPSE_MS
}

/**
 * Stop the transcript following its end, as a turn of the wheel does.
 *
 * While the reader is at the end the scroller pins it there through every
 * change in height. That is right for an answer streaming in, and wrong for
 * text the reader just asked to see: the message would grow upward out of
 * view, leaving them at its last line. The scroller stops following only
 * from its own wheel, touch and key handlers and offers no call for it, so
 * this is a wheel event with no distance in it. Following starts again when
 * they scroll back to the end.
 */
function releaseFollow(from: HTMLElement) {
  if (typeof WheelEvent === "undefined") return
  from.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 0 }))
}

/** Whether an element's top is hidden above the transcript's view, under its header included. */
function startsAboveView(element: HTMLElement): boolean {
  const scroller = element.closest<HTMLElement>("[data-slot='message-scroller-viewport']")
  const viewTop = scroller
    ? scroller.getBoundingClientRect().top + (Number.parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0)
    : 0
  return element.getBoundingClientRect().top < viewTop
}

/**
 * Marks the element a folded message can be opened by clicking: its bubble,
 * padding included. Without one, the text itself is the surface.
 */
export const FOLD_SURFACE_ATTRIBUTE = "data-fold-surface"

/** Things inside a message that have a click of their own. */
const OWN_CLICK_SELECTOR = "a, button, input, textarea, select, summary, label, img, video, audio, [role='button'], [role='link'], [contenteditable='true']"
/** A press that travels further than this before it lifts is a drag. */
const CLICK_SLOP_PX = 4

/**
 * Whether a click on a folded message's bubble is the reader asking to open
 * it, as a press on Show more is.
 *
 * It is unless it was something else. A drag is a selection being made. A
 * click with text selected, now or when the press began, is a selection
 * being finished or let go, and opening the message under it would be a
 * second thing the reader did not ask for. A second or third click in a row
 * is a word or a paragraph being selected. A right click or a modified one
 * belongs to the menu or the browser. And a link, a copy button, an image or
 * a queued message's controls answer their own click.
 */
export function isFoldClick({ button, clicks, modified, movedPx, selecting, onOwnClick, handled }: {
  /** `MouseEvent.button`: 0 is the main one. */
  button: number
  /** `MouseEvent.detail`: 1 for a single click. */
  clicks: number
  /** Any of ctrl, meta, shift or alt was held. */
  modified: boolean
  /** How far the pointer moved between going down and coming up. */
  movedPx: number
  /** Text was selected when the press began, or is now. */
  selecting: boolean
  /** The click landed on something with a click of its own. */
  onOwnClick: boolean
  /** Something inside already took the click (`defaultPrevented`). */
  handled: boolean
}): boolean {
  if (button !== 0 || modified || handled || onOwnClick) return false
  if (clicks > 1) return false
  if (movedPx > CLICK_SLOP_PX) return false
  return !selecting
}

function hasSelectedText(): boolean {
  const selection = typeof window !== "undefined" ? window.getSelection() : null
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim())
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function ClampedMessageText({ text, lines, scopeRef }: {
  text: string
  /** The most lines to show while collapsed: one of `CLAMP_LINES`. */
  lines: number
  /** What to keep on screen when the text collapses: the bubble, where it holds more than the text. */
  scopeRef?: RefObject<HTMLElement | null>
}) {
  const clipRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const textId = useId()
  const [expanded, setExpanded] = useState(false)
  // False until measured, so a message that fits never shows the control.
  const [overflows, setOverflows] = useState(false)
  // Set by a press, read by the effect that follows it: where the move starts.
  const pressRef = useRef<{ from: number; byKeyboard: boolean } | null>(null)
  const animationRef = useRef<Animation | null>(null)

  useLayoutEffect(() => {
    const clip = clipRef.current
    const content = contentRef.current
    if (!clip || !content || typeof ResizeObserver === "undefined") return
    const measure = () => {
      // The text's own height against the limit in lines of its own type.
      // Its own, not the clipped box's: a box held at the limit does not
      // change size when what is inside it does, and would never report a
      // late font, a loaded image or new text.
      const lineHeight = Number.parseFloat(getComputedStyle(clip).lineHeight)
      const limit = Number.isFinite(lineHeight) ? lineHeight * lines : clip.clientHeight
      setOverflows(content.offsetHeight > limit + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [lines])

  useLayoutEffect(() => {
    const clip = clipRef.current
    const content = contentRef.current
    const press = pressRef.current
    pressRef.current = null
    // Only a press moves it. The first render, and a re-render, do not.
    if (!clip || !content || !press) return
    animationRef.current?.cancel()
    animationRef.current = null

    const scope = scopeRef?.current ?? clip
    const to = expanded ? content.offsetHeight : Number.parseFloat(getComputedStyle(clip).lineHeight) * lines
    const ms = clampTransitionMs({
      expanding: expanded,
      from: press.from,
      to,
      reducedMotion: prefersReducedMotion(),
      byKeyboard: press.byKeyboard,
      startsAboveView: !expanded && startsAboveView(scope),
    })
    if (ms === null || typeof clip.animate !== "function") {
      // Collapsing from the foot of a long message takes the message out
      // from under the reader. Bring what is left of it back into view. If
      // what is left is taller than the view, as a typed message's 25 lines
      // can be in a small window, `nearest` brings its foot: the last lines
      // and the control just pressed, with the next row under them.
      if (!expanded) scope.scrollIntoView({ block: "nearest" })
      return
    }
    // From wherever it is now, so a second press mid-move turns it around
    // instead of starting over. Clipped throughout: open, the box clips
    // nothing, and the text would show at full height from the first frame.
    animationRef.current = clip.animate(
      [
        { maxHeight: `${press.from}px`, overflow: "hidden" },
        { maxHeight: `${to}px`, overflow: "hidden" },
      ],
      { duration: ms, easing: EASE_OUT },
    )
  }, [expanded, lines, scopeRef])

  // The one way the text opens or closes, whatever was pressed.
  const toggle = (pressed: HTMLElement, byKeyboard: boolean) => {
    const clip = clipRef.current
    pressRef.current = clip ? { from: clip.getBoundingClientRect().height, byKeyboard } : null
    if (!expanded) releaseFollow(pressed)
    setExpanded(!expanded)
  }
  // `detail` counts clicks, and a click made by Enter or Space has none.
  const onControlClick = (event: MouseEvent<HTMLButtonElement>) => toggle(event.currentTarget, event.detail === 0)

  // While folded, a click anywhere on the bubble opens it: the text that is
  // cut off is the thing asking to be opened, and the control under it is a
  // small target for that. Only while folded. Open, the bubble is text to
  // read and select, and Show less is how it closes.
  //
  // The control stays the only thing in the tab order and the only thing a
  // screen reader is told about. This is a shortcut to it for a pointer, so
  // the bubble gets a pointer's cursor and no role.
  const foldedOpen = overflows && !expanded
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  useEffect(() => {
    const clip = clipRef.current
    const surface = clip?.closest<HTMLElement>(`[${FOLD_SURFACE_ATTRIBUTE}]`) ?? clip
    if (!foldedOpen || !surface) return
    let press: { x: number; y: number; selecting: boolean } | null = null
    // Before the browser's own mousedown, which is what clears a selection:
    // the only moment that still knows there was one.
    const onPointerDown = (event: PointerEvent) => {
      press = { x: event.clientX, y: event.clientY, selecting: hasSelectedText() }
    }
    const onClick = (event: globalThis.MouseEvent) => {
      const began = press
      press = null
      const own = event.target instanceof Element ? event.target.closest(OWN_CLICK_SELECTOR) : null
      const open = isFoldClick({
        button: event.button,
        clicks: event.detail,
        modified: event.ctrlKey || event.metaKey || event.shiftKey || event.altKey,
        movedPx: began ? Math.hypot(event.clientX - began.x, event.clientY - began.y) : 0,
        selecting: Boolean(began?.selecting) || hasSelectedText(),
        // Inside the bubble, not around it: the bubble may itself sit in something pressable.
        onOwnClick: own !== null && surface.contains(own),
        handled: event.defaultPrevented,
      })
      if (open) toggleRef.current(surface, false)
    }
    // The whole bubble, text included, says it can be pressed. A text cursor
    // over the text would say "select", which still works by dragging but is
    // not what a press here does.
    const cursor = surface.style.cursor
    surface.style.cursor = "pointer"
    surface.addEventListener("pointerdown", onPointerDown)
    surface.addEventListener("click", onClick)
    return () => {
      surface.style.cursor = cursor
      surface.removeEventListener("pointerdown", onPointerDown)
      surface.removeEventListener("click", onClick)
    }
  }, [foldedOpen])

  const clamped = !expanded
  return (
    <>
      <div
        ref={clipRef}
        id={textId}
        className={cn(
          clamped && "overflow-hidden",
          clamped && overflows && "[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1lh),transparent)]",
        )}
        // In lines of the text's own type. A style, not a class: the number
        // is the caller's, and a class has to be spelled out to exist.
        style={clamped ? { maxHeight: `${lines}lh` } : undefined}
      >
        <div ref={contentRef} className={TEXT_CLASS}>
          <TranscriptMarkdown text={text} />
        </div>
      </div>
      {overflows ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={textId}
          onClick={onControlClick}
          // 28px tall and flush under the text: the room is inside the button,
          // so the whole strip is the target. Under a finger it is 44px, the
          // extra reaching over the text's last line and the bubble's padding.
          // Pulled left by its own padding so the label lines up with the
          // text above it.
          className={cn(
            "not-prose relative -ml-1.5 flex h-7 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none select-none",
            "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-2 pointer-coarse:before:content-['']",
            "transition-[color,scale] duration-150 ease-snappy active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100",
          )}
        >
          {expanded ? "Show less" : "Show more"}
          <ChevronDown className={cn("size-3.5 transition-transform duration-200 ease-snappy motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
      ) : null}
    </>
  )
}
