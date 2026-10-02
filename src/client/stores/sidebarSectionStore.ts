import { useCallback } from "react"
import { create } from "zustand"

/**
 * Which sidebar sections you have opened or folded, against their defaults.
 *
 * Held here rather than in the lists themselves because the lists come and
 * go: opening a channel replaces the channel list with that project's chats,
 * and going back mounts the channel list anew. In a component's own state
 * every such trip would put each section back to its default.
 *
 * One set of overrides per list (`scope`), keyed by the section's stable key.
 * In memory only: a reload starts from the defaults.
 */

type SectionOverrides = Readonly<Record<string, boolean>>

interface SidebarSectionState {
  overrides: Readonly<Record<string, SectionOverrides>>
  setExpanded: (scope: string, sectionKey: string, expanded: boolean) => void
}

const NO_OVERRIDES: SectionOverrides = {}

const useSidebarSectionStore = create<SidebarSectionState>()((set) => ({
  overrides: {},
  setExpanded: (scope, sectionKey, expanded) => set((state) => ({
    overrides: {
      ...state.overrides,
      [scope]: { ...state.overrides[scope], [sectionKey]: expanded },
    },
  })),
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
