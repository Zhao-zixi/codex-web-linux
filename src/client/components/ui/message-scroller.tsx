import * as React from "react"
import {
  MessageScroller as MessageScrollerPrimitive,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
} from "@shadcn/react/message-scroller"

import { cn } from "../../lib/utils"

/**
 * Vendored from the shadcn registry (`message-scroller`), adapted for this repo:
 * our `cn`, and without the registry's `MessageScrollerButton` — the transcript
 * keeps its own scroll-to-bottom control, which carries app styling and marks
 * the jump as a deliberate read-position change. Registry utility classes that
 * do not exist in our Tailwind setup (`scroll-fade-b`, `scrollbar-*`) are
 * dropped rather than vendored as no-ops; the call site supplies its own.
 *
 * The behaviour we rely on lives in the primitive: scroll anchoring across
 * content growth, and follow-the-end while the reader is at the end.
 *
 * The primitive itself gets one patch at build time
 * (`vite-plugin-message-scroller.ts`): its content-height measure called
 * `getBoundingClientRect` on every row, on every scroll event and every
 * content resize. A streaming turn resizes the content on every push, so that
 * sweep was a forced layout of the whole transcript per push. The patch
 * measures the content box once instead. Re-check it on a version bump.
 */

function MessageScrollerProvider(
  props: React.ComponentProps<typeof MessageScrollerPrimitive.Provider>
) {
  return <MessageScrollerPrimitive.Provider {...props} />
}

function MessageScroller({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Root>) {
  return (
    <MessageScrollerPrimitive.Root
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerViewport({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Viewport>) {
  return (
    <MessageScrollerPrimitive.Viewport
      data-slot="message-scroller-viewport"
      className={cn("size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain", className)}
      {...props}
    />
  )
}

function MessageScrollerContent({
  className,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Content>) {
  return (
    <MessageScrollerPrimitive.Content
      data-slot="message-scroller-content"
      // No `min-h-full` (the registry has it). WebKit re-lays out every
      // percentage-height element whenever an ancestor lays out, and the
      // composer resizing itself on each keystroke is such a layout: with
      // `min-height: 100%` here, every keystroke laid out every message again.
      // Measured in Safari 26 on a 203-row chat: 149 ms per keystroke with
      // it, 9 ms without. Containment doesn't stop it. Nothing here needs the
      // content to fill the viewport; rows stack from the top either way.
      className={cn("flex h-max flex-col", className)}
      // The registry's trailing spacer, held at zero height.
      //
      // The primitive grows it on every `scrollToElement` by exactly the
      // shortfall between the scroll position asked for and the furthest the
      // content can actually scroll — buying the range to park a near-final
      // message at the top of the viewport. The cost is a stretch of empty
      // transcript below the last message that reads as overscroll, and that
      // outlives the jump: it is only recomputed on the next programmatic
      // scroll, so it sits there through everything the reader does by hand.
      //
      // Not worth what it buys. A jump near the end of a chat now scrolls as
      // far as the content allows and the message lands wherever that leaves
      // it, which is what every other transcript does — and the jump flash
      // already says which message it was, so nothing depends on the message
      // being at a fixed height on screen.
      //
      // `display: none` rather than a zero height because the primitive writes
      // `height` inline and would win any contest over that property. It sets
      // `hidden` too, but only ever toggles it off, so the class is what holds.
      spacerClassName="hidden"
      {...props}
    />
  )
}

function MessageScrollerItem({
  className,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<typeof MessageScrollerPrimitive.Item>) {
  return (
    <MessageScrollerPrimitive.Item
      data-slot="message-scroller-item"
      scrollAnchor={scrollAnchor}
      // No `content-visibility: auto` here, and no `contain-intrinsic-size`
      // guess with it. Together they size every off-screen row from the guess
      // until that row renders once. A tool row is ~40px and a long answer is
      // many hundreds, so a guess is always wrong for some rows. Scrolling up
      // then resized the rows above the reader and slid the text under their
      // finger. Safari has no scroll anchoring to correct that.
      //
      // Tried twice on Chromium alone, where scroll anchoring hides the
      // resize. Both times every row crossing the viewport edge flipped its
      // render state, which re-layerized and repainted on nearly every frame
      // (paint work tripled in a scroll profile; ~100 state flips per ten
      // seconds of streaming in a second one). The reason it existed, an
      // 800-row DOM on open, is gone now that a chat opens on a window of the
      // transcript. A full render is what keeps scrolling honest.
      className={cn(
        "min-w-0 shrink-0",
        className
      )}
      {...props}
    />
  )
}

export {
  MessageScroller,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
