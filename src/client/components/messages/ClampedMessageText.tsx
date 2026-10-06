import { useId, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from "react"
import { ChevronDown } from "lucide-react"
import { cn } from "../../lib/utils"
import { TranscriptMarkdown } from "./shared"

/**
 * The text of a message sent to the agent, held to five lines until asked
 * for. Every such message uses this: what the user typed, what another agent,
 * a sub-chat or a schedule sent, and each of those while it waits in the
 * queue. A long prompt is a wall between one answer and the next, and the
 * reader of a transcript is there for the answers. Those are never clamped.
 *
 * The limit is a height, not a line clamp: the text is markdown, and a clamp
 * counts lines inside one block. The last line fades out instead of being cut,
 * because a heading or a list does not land on the paragraph's line grid, and
 * a hard edge there slices through letters. The fade is a mask on the text,
 * not a gradient laid over it, so it has no colour of its own to match to
 * whatever is behind: a filled bubble, a dashed outline, either theme.
 */

/** Also written into `max-h-[5lh]` below, which Tailwind has to read as a literal. */
export const CLAMP_LINES = 5

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

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

export function ClampedMessageText({ text, scopeRef }: {
  text: string
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
      // The text's own height against five lines of its own type. Its own,
      // not the clipped box's: a box held at five lines does not change size
      // when what is inside it does, and would never report a late font, a
      // loaded image or new text.
      const lineHeight = Number.parseFloat(getComputedStyle(clip).lineHeight)
      const limit = Number.isFinite(lineHeight) ? lineHeight * CLAMP_LINES : clip.clientHeight
      setOverflows(content.offsetHeight > limit + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(content)
    return () => observer.disconnect()
  }, [])

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
    const to = expanded ? content.offsetHeight : Number.parseFloat(getComputedStyle(clip).lineHeight) * CLAMP_LINES
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
      // from under the reader. Bring what is left of it back into view.
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
  }, [expanded, scopeRef])

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    const clip = clipRef.current
    // `detail` counts clicks, and a click made by Enter or Space has none.
    pressRef.current = clip ? { from: clip.getBoundingClientRect().height, byKeyboard: event.detail === 0 } : null
    if (!expanded) releaseFollow(event.currentTarget)
    setExpanded(!expanded)
  }

  const clamped = !expanded
  return (
    <>
      <div
        ref={clipRef}
        id={textId}
        className={cn(
          clamped && "max-h-[5lh] overflow-hidden",
          clamped && overflows && "[mask-image:linear-gradient(to_bottom,black_calc(100%_-_1lh),transparent)]",
        )}
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
          onClick={toggle}
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
