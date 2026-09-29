import { useMemo, useState } from "react"
import { useOutletContext } from "react-router-dom"
import { DEFAULT_NEW_PROJECTS_DIRECTORY } from "../../shared/types"
import { SetupCard } from "../components/auth/SetupCard"
import { LocalDev } from "../components/LocalDev"
import { repoKey } from "../components/home/homeItems"
import { ProjectsHome } from "../components/home/ProjectsHome"
import { ProjectSectionMenu } from "../components/chat-ui/sidebar/Menus"
import { ArchivedChatsDialog } from "../components/chat-ui/sidebar/ArchivedChatsDialog"
import { useSidebarStore } from "../stores/sidebarStore"
import type { KannaState } from "./useKannaState"

export function LocalProjectsPage() {
  const state = useOutletContext<KannaState>()
  const sidebarData = useSidebarStore((store) => store.data)
  const groupsByPath = useMemo(
    () => new Map(sidebarData.projectGroups.map((group) => [group.localPath, group])),
    [sidebarData]
  )
  // Each local project's GitHub remote, so a repo that's already cloned
  // shows once, as its local row.
  const repoKeyByPath = useMemo(() => {
    const keys = new Map<string, string>()
    for (const group of sidebarData.projectGroups) {
      const key = repoKey(group.repoUrl)
      if (key) keys.set(group.localPath, key)
    }
    return keys
  }, [sidebarData])
  const [archive, setArchive] = useState<{ localPath: string; nowMs: number } | null>(null)
  const archivedGroup = archive ? groupsByPath.get(archive.localPath) : undefined

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      {/* The Mac app's title bar across the projects page: it drags the
          window, as on the settings page. The page starts with pt-16 of
          empty space, so at the top of the scroll it covers nothing
          clickable. */}
      <div
        data-window-drag
        aria-hidden
        className="hidden mac-app:md:block absolute inset-x-0 top-0 z-10 h-[calc(var(--mac-traffic-lights-center)*2)]"
      />
      <LocalDev connectionStatus={state.connectionStatus} ready={state.localProjectsReady}>
        <ProjectsHome
          machineName={state.localProjects?.machine.displayName ?? "This machine"}
          projects={state.localProjects?.projects ?? []}
          repoKeyByPath={repoKeyByPath}
          startingLocalPath={state.startingLocalPath}
          commandError={state.commandError}
          onOpenProject={state.handleOpenLocalProject}
          socket={state.socket}
          newProjectsDirectory={state.appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY}
          onCloneRepo={state.handleCreateProject}
          setup={<SetupCard className="mb-6" />}
          renderProjectMenu={(project, row) => (
            <ProjectSectionMenu
              key={project.localPath}
              editorLabel={state.editorLabel}
              repoUrl={groupsByPath.get(project.localPath)?.repoUrl}
              onNewChat={() => { void state.handleOpenLocalProject(project.localPath) }}
              newChatDisabled={state.connectionStatus !== "connected" || state.startingLocalPath === project.localPath}
              onRename={() => { void state.handleRenameProject({ localPath: project.localPath }, project.sidebarTitle, project.title) }}
              onCopyPath={() => { void state.handleCopyPath(project.localPath) }}
              onShowArchived={() => setArchive({ localPath: project.localPath, nowMs: Date.now() })}
              onOpenInFinder={() => { void state.handleOpenExternalPath("open_finder", project.localPath) }}
              onOpenInEditor={() => { void state.handleOpenExternalPath("open_editor", project.localPath) }}
              onHide={() => { void state.handleHideProject({ localPath: project.localPath }) }}
            >
              {row}
            </ProjectSectionMenu>
          )}
        />
      </LocalDev>
      <ArchivedChatsDialog
        open={archive !== null}
        description={archive?.localPath}
        chats={archivedGroup?.archivedChats ?? []}
        nowMs={archive?.nowMs ?? Date.now()}
        onOpenChange={(open) => { if (!open) setArchive(null) }}
        onOpenChat={(chatId) => { void state.handleOpenArchivedChat(chatId) }}
        onRestoreChat={(chatId) => { void state.handleRestoreChat(chatId) }}
      />
    </div>
  )
}
