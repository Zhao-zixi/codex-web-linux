import { ChevronLeft } from "lucide-react"
import { cn } from "../../../lib/utils"

/**
 * The one visible sign that focus mode is on: the project the sidebar is
 * narrowed to, in the place of the logo and wordmark, with a back chevron.
 *
 * Focus mode is a page pushed onto the sidebar (`useFocusMotion` in
 * KannaSidebar), and this is that page's navigation bar title: it says where
 * you are and is the way back, as the logo it replaces is the way home.
 */
export function FocusModePill({
  projectTitle,
  shortcutHint,
  onExit,
  className,
}: {
  projectTitle: string
  /** Shown in the tooltip, e.g. "⌘⇧F". Omitted when the action is unbound. */
  shortcutHint?: string
  onExit: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onExit}
      title={shortcutHint ? `Exit focus mode (${shortcutHint})` : "Exit focus mode"}
      aria-label={`Exit focus mode: ${projectTitle}`}
      className={cn(
        // 6px after the 20px chevron starts the name where the rows below
        // start their labels (8px after a 16px icon on the same center).
        "flex min-w-0 items-center gap-1.5 text-sm max-md:text-base font-medium text-foreground transition-colors hover:text-muted-foreground",
        className
      )}
    >
      <ChevronLeft className="size-5 shrink-0" />
      {/* The project name is the one part of the bar with no length limit. */}
      <span className="min-w-0 truncate">{projectTitle}</span>
    </button>
  )
}
