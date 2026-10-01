import { create } from "zustand"
import type { SidebarView } from "../components/chat-ui/sidebar/SidebarViewSwitcher"
import { SIDEBAR_VIEW_STORAGE_KEY } from "../lib/storageKeys"
import { useAppSettingsStore } from "./appSettingsStore"

/**
 * Which view the sidebar is in. A store rather than the sidebar's own state
 * because Channels is more than a sidebar view: the layout puts a thread list
 * beside the chat, and the chat page gains a way to close the thread.
 */

type ReturnView = Exclude<SidebarView, "archived">

interface SidebarViewState {
  view: SidebarView
  /**
   * Where Archived hands you back to. Archived is somewhere you visit and get
   * returned from, so it is never persisted: what's stored is this, across
   * reloads as well as within a session.
   */
  returnView: ReturnView
  setView: (view: SidebarView) => void
  /** Back to the view you were in before Archived. A no-op from anywhere else. */
  leaveArchived: () => void
}

function readStoredSidebarView(): ReturnView {
  if (typeof window === "undefined") return "recents"
  const stored = window.localStorage.getItem(SIDEBAR_VIEW_STORAGE_KEY)
  return stored === "projects" || stored === "channels" ? stored : "recents"
}

export const useSidebarViewStore = create<SidebarViewState>()((set) => ({
  view: readStoredSidebarView(),
  returnView: readStoredSidebarView(),

  setView: (view) => {
    if (view === "archived") {
      set({ view })
      return
    }
    if (typeof window !== "undefined") window.localStorage.setItem(SIDEBAR_VIEW_STORAGE_KEY, view)
    set({ view, returnView: view })
  },

  leaveArchived: () => set((state) => (state.view === "archived" ? { view: state.returnView } : state)),
}))

/**
 * Whether the app is laid out as channels: projects in the sidebar, a
 * project's threads beside the open chat. The view switcher only exists in the
 * new sidebar, so without it the stored view is not in effect.
 */
export function useChannelsLayout(): boolean {
  const newSidebarEnabled = useAppSettingsStore((store) => store.settings?.newSidebarEnabled !== false)
  return useSidebarViewStore((state) => state.view === "channels") && newSidebarEnabled
}
