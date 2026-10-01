import { Archive, Folder, Hash, ListFilter, MessageCircle } from "lucide-react"
import { cn } from "../../../lib/utils"
import { buttonVariants } from "../../ui/button"
import { InputPopover, PopoverMenuItem } from "../ChatPreferenceControls"

/** Which view the sidebar shows when the recent-chats Labs mode is enabled. */
export type SidebarView = "recents" | "projects" | "channels" | "archived"

/**
 * One row's text: the name with its qualifier trailing it inline — rows in a
 * picker this small read better on one line each.
 *
 * Same treatment as `PopoverMenuItem`'s own `description` subtitle. The weight
 * has to be stated: unlike that slot, this sits *inside* the label, so it would
 * otherwise inherit its medium weight and read as part of the name.
 */
function ViewLabel({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span>{name}</span>
      <span className="text-xs font-normal text-muted-foreground">{detail}</span>
    </span>
  )
}

/**
 * Swaps the sidebar between its Chats, Projects, Channels and Archived views.
 * Channels changes more than the sidebar: see `useChannelsLayout`.
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
            label={<ViewLabel name="Chats" detail="grouped by relevance" />}
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("projects")
            }}
            selected={view === "projects"}
            icon={<Folder className="h-4 w-4" />}
            label={<ViewLabel name="Projects" detail="grouped by recency" />}
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("channels")
            }}
            selected={view === "channels"}
            icon={<Hash className="h-4 w-4" />}
            label={<ViewLabel name="Channels" detail="threads by project" />}
          />
          <PopoverMenuItem
            onClick={() => {
              close()
              onChange("archived")
            }}
            selected={view === "archived"}
            icon={<Archive className="h-4 w-4" />}
            label={<ViewLabel name="Archived" detail="recently archived" />}
          />
        </>
      )}
    </InputPopover>
  )
}
