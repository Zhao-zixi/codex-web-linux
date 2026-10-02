import { type ComponentProps, useEffect, useRef, useState } from "react"
import { ListHoverCard } from "../../ui/list-hover-card"

/**
 * A widget list's hover card: the app's list hover card (`ListHoverCard`),
 * opening leftward. The widget column sits at the window's right edge, so the
 * card opens to the rows' left, over the chat. Rows mark themselves with
 * WidgetRow's `rowKey` (`data-row-key`).
 */
export function WidgetHoverCard(props: Omit<ComponentProps<typeof ListHoverCard>, "side" | "rowAttribute">) {
  return <ListHoverCard side="left" {...props} />
}

/**
 * Lazily fetched card details, cached by a key that changes when the thing
 * does (a commit's checks, a branch's tip time, a file's patch digest).
 * Bounded, since a long session hovers a lot of rows.
 *
 * When the key moves under an open card, the old details stay until the new
 * ones land: a card is keyed by its row, so they are the same thing's, only
 * older, and blanking them would collapse the card under the reader.
 */
export function useCardDetails<T>(
  cache: Map<string, T>,
  cacheKey: string | null,
  load: (() => Promise<T>) | null,
  limit = 100,
): T | null {
  const [details, setDetails] = useState<T | null>(() => (cacheKey ? cache.get(cacheKey) ?? null : null))
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const currentLoad = loadRef.current
    if (!cacheKey || !currentLoad) {
      setDetails(null)
      return
    }
    const cached = cache.get(cacheKey)
    if (cached !== undefined) {
      setDetails(cached)
      return
    }
    let cancelled = false
    currentLoad()
      .then((result) => {
        if (cache.size >= limit) cache.delete(cache.keys().next().value!)
        cache.set(cacheKey, result)
        if (!cancelled) setDetails(result)
      })
      // The card still says what the row knew; only the fetched part waits,
      // and it simply doesn't appear.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [cache, cacheKey, limit])
  return details
}
