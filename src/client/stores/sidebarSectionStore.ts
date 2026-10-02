import { useCallback } from "react"
import { create } from "zustand"
import { SIDEBAR_PINNED_EXPANDED_STORAGE_KEY } from "../lib/storageKeys"

/**
 * Which sidebar sections you have opened or folded, against their defaults.
 *
 * Held here rather than in the lists themselves because the lists come and
 * go: opening a channel replaces the channel list with that project's chats,
 * and going back mounts the channel list anew. In a component's own state
 * every such trip would put each section back to its default.
 *
 * One set of overrides per list (`scope`), keyed by the section's stable key.
 *
 * In memory, so a reload starts from the defaults, except for Pinned, which
 * is kept in this browser. The other sections are named for what is in them
 * today (a date, "Relevant"), and a fold that outlived the day would hide
 * tomorrow's chats under the same name. Pinned is the one section that is
 * the same thing every day, and folding it is a standing choice.
 */

type SectionOverrides = Readonly<Record<string, boolean>>

interface SidebarSectionState {
  overrides: Readonly<Record<string, SectionOverrides>>
  setExpanded: (scope: string, sectionKey: string, expanded: boolean) => void
}

const NO_OVERRIDES: SectionOverrides = {}

/** The one section whose fold is remembered across reloads. */
const PERSISTED_SECTION_KEY = "pinned"

function readStoredOverrides(): Record<string, SectionOverrides> {
  if (typeof window === "undefined") return {}
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(SIDEBAR_PINNED_EXPANDED_STORAGE_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object") return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean")
        .map(([scope, expanded]) => [scope, { [PERSISTED_SECTION_KEY]: expanded }])
    )
  } catch {
    return {}
  }
}

function persistPinnedOverrides(overrides: Readonly<Record<string, SectionOverrides>>) {
  if (typeof window === "undefined") return
  const stored = Object.fromEntries(
    Object.entries(overrides).flatMap(([scope, sections]) => (
      PERSISTED_SECTION_KEY in sections ? [[scope, sections[PERSISTED_SECTION_KEY]]] : []
    ))
  )
  window.localStorage.setItem(SIDEBAR_PINNED_EXPANDED_STORAGE_KEY, JSON.stringify(stored))
}

const useSidebarSectionStore = create<SidebarSectionState>()((set) => ({
  overrides: readStoredOverrides(),
  setExpanded: (scope, sectionKey, expanded) => set((state) => {
    const overrides = {
      ...state.overrides,
      [scope]: { ...state.overrides[scope], [sectionKey]: expanded },
    }
    if (sectionKey === PERSISTED_SECTION_KEY) persistPinnedOverrides(overrides)
    return { overrides }
  }),
}))

/** A list's overrides, and the setter for one of its sections. */
export function useSectionOverrides(scope: string) {
  const overrides = useSidebarSectionStore((state) => state.overrides[scope] ?? NO_OVERRIDES)
  const setStoreExpanded = useSidebarSectionStore((state) => state.setExpanded)
  const setExpanded = useCallback(
    (sectionKey: string, expanded: boolean) => setStoreExpanded(scope, sectionKey, expanded),
    [scope, setStoreExpanded]
  )
  return [overrides, setExpanded] as const
}
