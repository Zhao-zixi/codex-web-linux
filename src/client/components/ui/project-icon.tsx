import { memo, useState } from "react"
import { getProjectColor, getProjectInitials } from "../../lib/project-monogram"
import { cn } from "../../lib/utils"

/**
 * A project's mark at 16px: its own icon when the server found one
 * (`iconUrl`), and otherwise its initials on a colour taken from its name.
 */
export const ProjectIcon = memo(function ProjectIcon({ name, iconUrl, className }: {
  name: string
  iconUrl?: string
  className?: string
}) {
  // The URL that failed, not a flag: a changed icon is a new URL and gets its own try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null)

  if (iconUrl && iconUrl !== failedUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailedUrl(iconUrl)}
        className={cn("size-4 shrink-0 rounded-[4px] object-contain", className)}
      />
    )
  }

  const initials = getProjectInitials(name)
  return (
    <span
      aria-hidden
      style={{ backgroundColor: getProjectColor(name) }}
      className={cn(
        // Its own weight and tracking: the row around it goes bold when unread.
        "flex size-4 shrink-0 select-none items-center justify-center rounded-[4px] font-bold leading-none tracking-tighter text-white",
        initials.length > 1 ? "text-[8px]" : "text-[10px]",
        className
      )}
    >
      {initials}
    </span>
  )
})
