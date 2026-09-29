import * as React from "react"
import * as HoverCardPrimitive from "@radix-ui/react-hover-card"
import { cn } from "../../lib/utils"

/**
 * Hover surface for content you can point *at*, as opposed to a tooltip, which
 * is content you can only point *near*.
 *
 * The difference is not styling. A tooltip is `role="tooltip"` and describes
 * its trigger, so anything clickable inside it is unreachable by keyboard and
 * unannounced by a screen reader. A hover card is a region: it can hold
 * targets, it survives the pointer travelling into it, and it dismisses on
 * Escape. Reach for this one the moment a hover surface grows something to
 * click.
 */

const HoverCard = HoverCardPrimitive.Root

const HoverCardTrigger = HoverCardPrimitive.Trigger

const HoverCardContent = React.forwardRef<
  React.ComponentRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = "center", sideOffset = 4, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 rounded-md border border-border bg-card text-card-foreground p-4 shadow-md outline-none floating-surface",
        className
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
))
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName

export { HoverCard, HoverCardTrigger, HoverCardContent }
