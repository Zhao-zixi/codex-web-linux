import { ListFilter, X } from "lucide-react"

/**
 * The one visible sign that focus mode is on: a row naming the project the
 * sidebar is narrowed to.
 *
 * Same row as New Chat and Add Project below it — same layout, padding and
 * type — but held in their hover treatment (`border-border bg-muted`) rather
 * than reaching it on hover. That is what reads as a tag: an ordinary row the
 * sidebar has picked out.
 *
 * The whole row is the exit control, not just the X. At this size the glyph
 * alone is a poor tap target, and there is nothing else the row could do.
 */
export function FocusModePill({
  projectTitle,
  shortcutHint,
  onExit,
}: {
  projectTitle: string
  /** Shown in the tooltip, e.g. "⌘⇧F". Omitted when the action is unbound. */
  shortcutHint?: string
  onExit: () => void
}) {
  return (
    <button
      type="button"
      onClick={onExit}
      title={shortcutHint ? `Exit focus mode (${shortcutHint})` : "Exit focus mode"}
      aria-label={`Exit focus mode: ${projectTitle}`}
      // mt-1 on top of the block's 1px row gap: the focus row is a different
      // kind of thing from the buttons above it, so it gets a little air.
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-border bg-muted px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:text-foreground"
    >
      <ListFilter className="h-4 w-4 shrink-0" />
      {/* Truncates like a chat row's title: the project name is the one part of
          this row that has no length limit. */}
      <span className="min-w-0 truncate">{projectTitle}</span>
      {/* 1px in from px-2: the X's diagonals read a hair right of its box. */}
      <X className="ml-auto mr-px h-4 w-4 shrink-0" />
    </button>
  )
}
