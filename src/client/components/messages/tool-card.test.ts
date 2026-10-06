import { expect, test } from "bun:test"
import { toolCardClasses } from "./tool-card"

test("a quote's border is the card's at half strength, resting and lit", () => {
  const card = toolCardClasses(false)
  const quote = toolCardClasses(true)

  expect(card.box).toContain("border-border ")
  expect(quote.box).toContain("border-border/50")
  // Lit by the pointer, and held lit while the hover card it opened is up.
  expect(card.lit).toBe("hover:border-muted-foreground/40 data-[hover-card-open]:border-muted-foreground/40")
  expect(quote.lit).toBe("hover:border-muted-foreground/20 data-[hover-card-open]:border-muted-foreground/20")
  // The card where a chat was started keeps its fill. The quote has none.
  expect(card.box).toContain("bg-card")
  expect(quote.box).toContain("bg-transparent")
})
