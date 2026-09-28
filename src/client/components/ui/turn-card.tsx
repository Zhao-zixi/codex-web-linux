import type { ReactNode } from "react"
import { cn } from "../../lib/utils"

/**
 * The shared parts of the two cards that describe a turn on hover — the
 * sidebar's chat card and the transcript minimap's.
 *
 * They answer the same question about the same thing ("what was asked here,
 * what came back, and when"), differing only in which turn they found and what
 * else they have room to say, so the pieces that carry that answer live here
 * and both cards assemble them. Keeping them in one place is what stops the two
 * readings of one fact from drifting into two different-looking facts.
 */

/**
 * The horizontal inset every row of a card carries, paired with a card whose
 * own padding is the other half.
 *
 * Split that way because one row — the message blocks — has a hover fill, and a
 * fill that stops where the text starts reads as a box bolted onto the line
 * rather than a band you can hit. Paying for it with negative margins on a
 * `w-full` element does not work: the width resolves against the parent's
 * content box and the margins then push both edges outward, so the fill
 * overhangs the card. Giving the padding to the rows and taking it off the card
 * puts every line at the same optical inset with nothing overhanging.
 *
 * A card using these rows therefore wants `px-1.5` of its own, not `px-3`.
 */
export const TURN_CARD_ROW_INSET = "px-1.5 py-0.5"

/** Type and colour for the small-print rows above and below the messages. */
const TURN_CARD_META_TEXT = "text-[12px] tracking-wide text-muted-foreground"

/** Bullet between two facts sharing one side of a meta row. */
export function TurnCardMetaSeparator() {
  return <span aria-hidden className="opacity-60">•</span>
}

/** A meta line — the small print a card carries above or below its messages. */
export function TurnCardMetaRow({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", TURN_CARD_META_TEXT, TURN_CARD_ROW_INSET, className)}>
      {children}
    </div>
  )
}

/**
 * One of a card's message blocks, clickable when the surface it sits on can
 * navigate at all.
 *
 * Falls back to plain text rather than a disabled button where it cannot — the
 * sidebar's archived list, which has no chat to open in place. Nothing should
 * suggest a click that will not happen.
 */
export function TurnCardMessage({
  children,
  className,
  onSelect,
  label,
}: {
  children: ReactNode
  className: string
  onSelect?: () => void
  label: string
}) {
  // Identical box metrics either way, so a message sits in exactly the same
  // place whether or not it happens to be clickable.
  if (!onSelect) return <div className={cn(className, TURN_CARD_ROW_INSET)}>{children}</div>

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onSelect}
      className={cn(
        TURN_CARD_ROW_INSET,
        "block w-full cursor-pointer rounded text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {/* The caller's classes go on an inner span, not the button. A button
          lays out its text in an anonymous inner box, so `line-clamp-*` on the
          button itself does not clamp anything and long text runs unclipped. */}
      <span className={className}>{children}</span>
    </button>
  )
}

/**
 * The footer: how much and when, anchored right; what and by whom on the left.
 *
 * `detail` and `timestamp` share the right edge with a bullet between them
 * because they read as one fact — "two minutes, an hour ago", "eight turns,
 * yesterday". Split to opposite ends they read as two unrelated columns, and
 * the left one floats mid-row with nothing to anchor it.
 *
 * Each card fills the two slots with what it knows the other doesn't. The
 * minimap describes one turn: its message count on the left, how long that turn
 * ran on the right. The sidebar describes a whole chat: the harness on the left,
 * how many turns it has run on the right. Same shape, same reading — scale is
 * the only thing that differs.
 *
 * Renders nothing at all when it has nothing to say, so a card with no footer
 * facts doesn't carry an empty line.
 */
export function TurnCardTimingRow({
  detail,
  timestamp,
  leading,
}: {
  /** The measure that pairs with the time — a duration, or a turn count. */
  detail?: string | null
  timestamp?: string | null
  leading?: ReactNode
}) {
  if (!detail && !timestamp && !leading) return null

  return (
    <TurnCardMetaRow className="mt-1">
      {leading ? <span className="flex min-w-0 items-center gap-1">{leading}</span> : null}
      {/* `ml-auto` on the group, so the pair holds the right edge together
          whether or not anything is sitting on the left. */}
      {detail || timestamp ? (
        <span className="ml-auto flex shrink-0 items-center gap-1 pl-2">
          {detail ? <span>{detail}</span> : null}
          {detail && timestamp ? <TurnCardMetaSeparator /> : null}
          {timestamp ? <span>{timestamp}</span> : null}
        </span>
      ) : null}
    </TurnCardMetaRow>
  )
}
