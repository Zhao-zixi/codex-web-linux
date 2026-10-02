import { Archive, Folder, Hash, ListFilter, MessageCircle } from "lucide-react"
import { cn } from "../../../lib/utils"
import { buttonVariants } from "../../ui/button"
import { InputPopover, PopoverMenuItem } from "../ChatPreferenceControls"

/** Which view the sidebar shows when the recent-chats Labs mode is enabled. */
export type SidebarView = "recents" | "projects" | "channels" | "archived"

/**
 * Swaps the sidebar between its Chats, Projects, Channels and Archived views.
 *
 * Sits at the right end of the New Chat row — one fixed spot that doesn't move
 * with the view or with which section happens to render first. It is the
 * header's Search button again (KannaSidebar): same ghost button, same hover,
 * same width and padding, in the web and the Mac app alike, so the two glyphs
 * and hover boxes share a right edge. The header ends 5px in (1px border +
 * pr-1) and this row 8px in (1px border + 7px), hence the -3px.
 */
export function SidebarViewSwitcher({
  view,
  onChange,
}: {
  view: SidebarView
  onChange: (view: SidebarView) => void
}) {
  return (
    <InputPopover
      // Right-edge trigger: hang the 16rem panel leftward, into the sidebar.
      align="end"
      // The Search button's classes, but h-8 everywhere: the row is 34px.
      triggerClassName={cn(
        buttonVariants({ variant: "ghost", size: "icon" }),
        "-mr-[3px] h-8 w-auto rounded-lg py-0 pl-1.5 pr-3 hover:!border-border/0 hover:!bg-transparent mac-app:md:pr-1.5"
      )}
      trigger={<ListFilter className="size-4 shrink-0" />}
    >
      {(close) => (
        <>
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("recents")
            }}
            selected={view === "recents"}
            icon={<MessageCircle className="h-4 w-4" />}
            label="Chats"
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("projects")
            }}
            selected={view === "projects"}
            icon={<Folder className="h-4 w-4" />}
            label="Projects"
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("channels")
            }}
            selected={view === "channels"}
            icon={<Hash className="h-4 w-4" />}
            label="Channels"
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("archived")
            }}
            selected={view === "archived"}
            icon={<Archive className="h-4 w-4" />}
            label="Archived"
          />
        </>
      )}
    </InputPopover>
  )
}
