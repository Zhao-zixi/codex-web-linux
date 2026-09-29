import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"
import { cn } from "../../lib/utils"
import { Kbd, KbdGroup } from "./kbd"

const HOTKEY_TOOLTIP_CONTENT_CLASSNAME =
  "z-50 overflow-hidden rounded-md border border-border backdrop-blur-md p-0.5 text-[11px] font-medium text-card-foreground shadow-sm"

const TooltipProvider = TooltipPrimitive.Provider

/**
 * Tooltips inside this scope appear and leave without motion. The sidebars
 * and the timeline are scanned by sweeping the pointer down a list, and there
 * a tooltip should keep up with the pointer, not play in behind it. Context
 * reaches through the portal, so wrapping a region covers every tooltip in it.
 */
const StillTooltipsContext = React.createContext(false)

function StillTooltips({ children }: { children: React.ReactNode }) {
  return <StillTooltipsContext.Provider value>{children}</StillTooltipsContext.Provider>
}

/** The shared motion (`floating-surface` in index.css), unless the tooltip is in a still scope. */
function useTooltipMotionClass() {
  return React.useContext(StillTooltipsContext) ? null : "floating-surface"
}

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => {
  const motionClass = useTooltipMotionClass()
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 overflow-hidden rounded-md bg-card text-card-foreground border border-border px-3 py-1.5 text-xs",
          motionClass,
          className
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  )
})
TooltipContent.displayName = TooltipPrimitive.Content.displayName

const HotkeyTooltip = TooltipPrimitive.Root

const HotkeyTooltipTrigger = TooltipPrimitive.Trigger

function formatHotkeyLabel(label: string) {
  return label.toUpperCase()
}

function renderShortcutKeys(shortcut: string) {
  const keys = shortcut.split("+")
  return (
    <KbdGroup>
      {keys.map((key, i) => (
        <Kbd key={`${key}-${i}`}>{formatHotkeyLabel(key)}</Kbd>
      ))}
    </KbdGroup>
  )
}

type HotkeyTooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
  shortcut?: string | string[]
}

const HotkeyTooltipContent = React.forwardRef<
  React.ComponentRef<typeof TooltipPrimitive.Content>,
  HotkeyTooltipContentProps
>(({ className, sideOffset = 4, children, shortcut, ...props }, ref) => {
  const firstShortcut = shortcut === undefined
    ? null
    : Array.isArray(shortcut)
      ? shortcut[0] ?? null
      : shortcut
  const motionClass = useTooltipMotionClass()

  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
          motionClass,
          className
        )}
        {...props}
      >
        {firstShortcut ? (
          renderShortcutKeys(firstShortcut)
        ) : (
          <span>{typeof children === "string" ? formatHotkeyLabel(children) : children}</span>
        )}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
})
HotkeyTooltipContent.displayName = "HotkeyTooltipContent"

export {
  HOTKEY_TOOLTIP_CONTENT_CLASSNAME,
  HotkeyTooltip,
  HotkeyTooltipTrigger,
  HotkeyTooltipContent,
  StillTooltips,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  formatHotkeyLabel,
}
