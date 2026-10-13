import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { Flower } from "lucide-react"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { CommandPalette } from "../components/command-palette/CommandPalette"
import { AppDialogProvider, useAppDialog } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { APP_NAME } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatBrowserNotificationPreference, ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { shouldShowChatBrowserNotification, showChatBrowserNotification } from "../lib/chatBrowserNotifications"
import { getSetupLaunchAction, useProviderAuthStore } from "../stores/providerAuthStore"
import { SetupWizard } from "../components/auth/SetupWizard"
import type { ChatPreview, ChatTouchedFilesResult, ProviderAuthSnapshot } from "../../shared/types"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getBrowserWindowTitle, getChatNotificationEvents, getChatSoundBurstCount, type ChatNotificationEvent } from "./chatNotifications"
import { KannaSidebar } from "./KannaSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { OpenRouterCallbackPage } from "./OpenRouterCallbackPage"
// Code-split: its own route, with 8 settings sections and a second
// react-markdown instance behind the changelog.
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })))
const WorkflowsGalleryPage = lazy(() => import("./WorkflowsGalleryPage").then((m) => ({ default: m.WorkflowsGalleryPage })))
import { TerminalPage } from "./TerminalPage"
import { useKannaState } from "./useKannaState"
import { useMigrateChannelPins } from "./useMigrateChannelPins"
import { useSidebarStore } from "../stores/sidebarStore"
import type { AppSettingsSnapshot } from "../../shared/types"
import { ensureBearerServiceWorker, getClientAuthMode, kannaFetch, setClientAuthMode, storeBearerSession } from "./auth-client"
import { shouldUseBearerServiceWorker } from "./protected-assets"
import { AdminPage } from "./AdminPage"
import { bindGatewayUserStorage } from "./gateway-user-state"

const AUTH_STATUS_RETRY_DELAY_MS = 500

interface AuthStatusResponse {
  enabled: boolean
  authenticated: boolean
  authMode?: "cookie" | "bearer"
  usernameRequired?: boolean
  user?: { id: string; username: string; role: "admin" | "user" } | null
}

type AppAuthState =
  | { status: "checking" }
  | { status: "ready"; user?: AuthStatusResponse["user"] }
  | { status: "locked"; error: string | null }

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (!payload.enabled || payload.authenticated) {
    return payload.user ? { status: "ready", user: payload.user } : { status: "ready" }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

function PasswordScreen({
  error,
  usernameRequired,
  onSubmit,
}: {
  error: string | null
  usernameRequired: boolean
  onSubmit: (password: string, username?: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [username, setUsername] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || (usernameRequired && !username.trim()) || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(password, username)
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md rounded-3xl border border-border bg-card shadow-sm">
        <CardHeader className="flex flex-col p-2 space-y-3 px-6 pt-6 pb-5 pl-[28px]">
          <div className="flex items-center gap-3">
            <Flower className="h-5 w-5 text-logo" />
            <div>
              <CardTitle className="font-logo text-xl uppercase text-slate-600 dark:text-slate-100">{APP_NAME}</CardTitle>
            </div>
          </div>
          <CardDescription className="leading-6">
            {usernameRequired ? "使用管理员提供的用户名和密码登录。" : "输入密码以继续。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
                {error}
              </div>
            ) : null}
            {usernameRequired ? <Input id="kanna-username" autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} placeholder="用户名" disabled={submitting} className="h-11 rounded-2xl bg-background"/> : null}
            <Input
              id="kanna-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="密码"
              disabled={submitting}
              className="h-11 rounded-2xl bg-background"
            />
            <Button
              type="submit"
              disabled={submitting || password.length === 0 || (usernameRequired && username.trim().length === 0)}
              className="h-11 w-full"
            >
              {submitting ? "正在登录…" : "登录"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function useAppAuthState() {
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const [usernameRequired, setUsernameRequired] = useState(false)
  const retryTimeoutRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    setState((current) => current.status === "ready" ? current : { status: "checking" })

    let response: Response
    try {
      response = await fetch("/auth/status", {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
        },
      })
    } catch {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (shouldRetryAuthStatusRequest(response.ok)) {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    setUsernameRequired(payload.usernameRequired === true)
    if (payload.authMode) setClientAuthMode(payload.authMode)
    if (payload.authMode === "bearer" && payload.usernameRequired === true) {
      if (shouldUseBearerServiceWorker()) {
        try {
          await ensureBearerServiceWorker()
        } catch {
          setState({ status: "locked", error: "Secure workspace media authorization could not start. Reload the page or contact the administrator." })
          return
        }
      }
      try {
        const bearerStatus = await kannaFetch("/auth/status", { cache: "no-store", headers: { Accept: "application/json" } })
        if (bearerStatus.ok) Object.assign(payload, await bearerStatus.json())
      } catch {}
    }
    if (payload.authMode === "cookie" && !payload.authenticated) {
      try {
        const legacyStatus = await fetch("/auth/status", { cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } })
        if (legacyStatus.ok) Object.assign(payload, await legacyStatus.json())
      } catch {}
    }
    if (payload.authMode === "bearer") {
      try {
        await bindGatewayUserStorage(payload.authenticated && payload.user?.id ? payload.user.id : null)
      } catch {
        setState({ status: "locked", error: "无法安全加载此账号的本地工作区状态，请重新加载页面。" })
        return
      }
    }
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useEffect(() => {
    void refresh()
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [refresh])

  const submitPassword = useCallback(async (password: string, username?: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      credentials: getClientAuthMode() === "bearer" ? "omit" : "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(usernameRequired
        ? { username, password }
        : { password, next: window.location.pathname + window.location.search }),
    })

    if (!response.ok) {
      setState({ status: "locked", error: "用户名或密码不正确。请重试。" })
      return
    }

    const payload = await response.json() as { token?: string; expiresAt?: number }
    if (payload.token && payload.expiresAt) {
      storeBearerSession(payload.token, payload.expiresAt)
      if (shouldUseBearerServiceWorker()) {
        try {
          await ensureBearerServiceWorker()
        } catch {
          setState({ status: "locked", error: "Secure workspace media authorization could not start. Reload the page or contact the administrator." })
          return
        }
      }
    }

    await refresh()
  }, [refresh, usernameRequired])

  return {
    state,
    usernameRequired,
    submitPassword,
  }
}

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

export function shouldShowChatNotificationPopup(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatBrowserNotificationPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldShowChatBrowserNotification(preference, doc)
}

function KannaLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useKannaState(params.chatId ?? null)

  // Feed the provider-auth store for the app's lifetime: sign-in state powers
  // the settings/new-chat auth cards, the harness picker's "Sign In" pills,
  // and the blocked-switch dialog.
  useEffect(() => {
    useProviderAuthStore.getState().setSocket(state.socket)
    const unsubscribe = state.socket.subscribe<ProviderAuthSnapshot>(
      { type: "provider-auth" },
      (snapshot) => useProviderAuthStore.getState().setSnapshot(snapshot),
    )
    return () => {
      unsubscribe()
      useProviderAuthStore.getState().setSocket(null)
    }
  }, [state.socket])

  // Onboarding auto-launch (see getSetupLaunchAction): a first-ever launch
  // opens the wizard instantly — cards show live probe status inside — while
  // later launches wait for the probe round and re-open only when something
  // is still unconnected. Decided at most once per app load; "Set up later"
  // and a completed run are both persisted per machine (server settings, not
  // this browser's localStorage) and suppress future launches everywhere, so
  // we also wait for `setupLoaded` before deciding anything.
  const authSnapshot = useProviderAuthStore((store) => store.snapshot)
  const setupLoaded = useProviderAuthStore((store) => store.setupLoaded)
  const setupLaunchDecidedRef = useRef(false)
  useEffect(() => {
    if (setupLaunchDecidedRef.current) return
    const { setupShown, setupCompleted, setupDismissed, openSetupWizard } =
      useProviderAuthStore.getState()
    const action = getSetupLaunchAction(authSnapshot, {
      setupLoaded,
      setupShown,
      setupCompleted,
      setupDismissed,
    })
    if (action === "wait") return
    setupLaunchDecidedRef.current = true
    if (action === "open") {
      openSetupWizard()
    }
  }, [authSnapshot, setupLoaded])

  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const chatBrowserNotificationPreference = useChatSoundPreferencesStore((store) => store.chatBrowserNotificationPreference)
  // Pages with no header of their own get a floating back button on mobile.
  const showMobileBackButton = location.pathname === "/home" || location.pathname === "/terminal"
  // Selected as the finished string rather than derived from the snapshot: the
  // title changes when a chat is renamed or a badge count moves, and this hook
  // should not re-render the layout for anything else the sidebar carries.
  const browserTitle = useSidebarStore((store) => getBrowserWindowTitle({
    appName: APP_NAME,
    sidebarData: store.data,
    activeProjectId: state.activeProjectId,
    activeChatId: state.activeChatId,
  }))
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void state.handleCreateChat(projectId)
  }, [state.handleCreateChat])
  const handleSidebarForkChat = useCallback((chat: Parameters<typeof state.handleForkChat>[0]) => {
    void state.handleForkChat(chat)
  }, [state.handleForkChat])
  const handleSidebarRenameChat = useCallback((chat: Parameters<typeof state.handleRenameChat>[0]) => {
    void state.handleRenameChat(chat)
  }, [state.handleRenameChat])
  const handleSidebarRenameProject = useCallback((projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    void state.handleRenameProject(projectId, sidebarTitle, realTitle)
  }, [state.handleRenameProject])
  const handleSidebarShareChat = useCallback((chatId: string) => {
    void state.handleShareChat(chatId)
  }, [state.handleShareChat])
  const handleSidebarArchiveChat = useCallback((chat: Parameters<typeof state.handleArchiveChat>[0]) => {
    void state.handleArchiveChat(chat)
  }, [state.handleArchiveChat])
  const handleOpenArchivedChat = useCallback((chatId: string) => {
    void state.handleOpenArchivedChat(chatId)
  }, [state.handleOpenArchivedChat])
  const handleRestoreChat = useCallback((chatId: string) => {
    void state.handleRestoreChat(chatId)
  }, [state.handleRestoreChat])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof state.handleDeleteChat>[0]) => {
    void state.handleDeleteChat(chat)
  }, [state.handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void state.handleCopyPath(localPath)
  }, [state.handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  // Straight to the socket rather than through `useKannaState`: the result is
  // read by one hover card and belongs to no snapshot, so there's no app state
  // for it to land in.
  const handleLoadTouchedFiles = useCallback((chatId: string) => (
    state.socket.command<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId })
  ), [state.socket])
  const handleLoadPreview = useCallback((chatId: string) => (
    state.socket.command<ChatPreview>({ type: "chat.getPreview", chatId })
  ), [state.socket])
  const handleSidebarSetupGit = useCallback((chatId: string) => {
    void state.handleSetupGit(chatId)
  }, [state.handleSetupGit])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void state.handleHideProject(projectId)
  }, [state.handleHideProject])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void state.handleReorderProjectGroups(projectIds)
  }, [state.handleReorderProjectGroups])
  // Straight to the socket, like the other one-line commands here: the pin
  // comes back on the sidebar snapshot, and nothing else has to hear of it.
  const handleSetProjectPinned = useCallback((projectId: string, pinned: boolean) => {
    void state.socket.command({ type: "project.setPinned", projectId, pinned }).catch(() => {})
  }, [state.socket])
  useMigrateChannelPins(state.socket, state.sidebarReady)
  const handleOpenChangelog = useCallback(() => {
    navigate("/settings/changelog")
  }, [navigate])
  // Rendered inline rather than through a `useMemo`: `KannaSidebar` is memoized
  // and every prop below is now stable, so React skips it on its own. The memo
  // wrapper used to be defeated anyway — its dep list named the sidebar
  // snapshot, which moved on every streamed token.
  const sidebarElement = (
    <KannaSidebar
      activeChatId={state.activeChatId}
      connectionStatus={state.connectionStatus}
      ready={state.sidebarReady}
      collapsed={state.sidebarCollapsed}
      showMobileBackButton={showMobileBackButton}
      onCollapse={state.collapseSidebar}
      onExpand={state.expandSidebar}
      onCreateChat={handleSidebarCreateChat}
      onCompose={state.handleCompose}
      onForkChat={handleSidebarForkChat}
      currentProjectId={state.activeProjectId}
      keybindings={state.keybindings}
      onRenameChat={handleSidebarRenameChat}
      onShareChat={handleSidebarShareChat}
      onToggleChatPin={state.handleToggleChatPin}
      onArchiveChat={handleSidebarArchiveChat}
      onOpenArchivedChat={handleOpenArchivedChat}
      onRestoreChat={handleRestoreChat}
      onDeleteChat={handleSidebarDeleteChat}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onSetupGit={handleSidebarSetupGit}
      onLoadTouchedFiles={handleLoadTouchedFiles}
      onLoadPreview={handleLoadPreview}
      onRenameProject={handleSidebarRenameProject}
      onHideProject={handleSidebarHideProject}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
      onSetProjectPinned={handleSetProjectPinned}
      editorLabel={state.editorLabel}
      updateSnapshot={state.updateSnapshot}
      onOpenChangelog={handleOpenChangelog}
    />
  )

  useLayoutEffect(() => {
    document.title = browserTitle
  }, [browserTitle, location.key])

  useEffect(() => {
    function handlePageShow() {
      document.title = browserTitle
    }

    function handlePageHide() {
      document.title = APP_NAME
    }

    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pageshow", handlePageShow)
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [browserTitle])

  // Driven by a store subscription rather than by a render: this compares
  // consecutive sidebar snapshots, and the layout is no longer re-rendered for
  // every one of them. The preferences are read through a ref so the
  // subscription is set up once and never torn down mid-turn (a resubscribe
  // would lose the previous snapshot and swallow the next chime).
  const soundSettingsRef = useRef({
    appSettings: state.appSettings,
    chatSoundPreference,
    chatSoundId,
    chatBrowserNotificationPreference,
    socket: state.socket,
  })
  useEffect(() => {
    soundSettingsRef.current = {
      appSettings: state.appSettings,
      chatSoundPreference,
      chatSoundId,
      chatBrowserNotificationPreference,
      socket: state.socket,
    }
  })
  // A system notification names its chat, so the body for a chat that only
  // turned unread is fetched on demand: the sidebar snapshot deliberately
  // carries no message previews. A waiting chat already has its question.
  const resolveChatNotificationMessage = useCallback(async (event: ChatNotificationEvent) => {
    if (event.message !== null) return event.message
    const preview = await soundSettingsRef.current.socket
      .command<ChatPreview>({ type: "chat.getPreview", chatId: event.chatId })
      .catch(() => null)
    return preview?.lastAgentMessagePreview ?? ""
  }, [])
  useEffect(() => {
    return useSidebarStore.subscribe((store, previousStore) => {
      // The first snapshot has nothing to compare against, and treating the
      // empty starting state as "previous" would chime once per unread chat on
      // every page load.
      if (!previousStore.ready) return
      const {
        appSettings,
        chatSoundPreference: preference,
        chatSoundId: soundId,
        chatBrowserNotificationPreference: popupPreference,
      } = soundSettingsRef.current

      const burstCount = getChatSoundBurstCount(previousStore.data, store.data)
      if (burstCount > 0 && shouldPlayChatNotificationSound(appSettings, preference)) {
        void playChatNotificationSound(soundId, burstCount).catch(() => undefined)
      }

      if (!shouldShowChatNotificationPopup(appSettings, popupPreference)) return
      for (const event of getChatNotificationEvents(previousStore.data, store.data)) {
        void resolveChatNotificationMessage(event).then((message) => {
          showChatBrowserNotification({
            ...event,
            message,
            onClick: () => {
              window.focus()
              navigate(`/chat/${event.chatId}`)
            },
          })
        })
      }
    })
  }, [navigate, resolveChatNotificationMessage])

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      {sidebarElement}
      <Outlet context={state} />
      <SetupWizard />
      <CommandPalette state={state} />
      <StandaloneShareDialog
        open={Boolean(state.standaloneShareUrl)}
        shareUrl={state.standaloneShareUrl ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            state.handleCloseStandaloneShareDialog()
          }
        }}
        onOpenLink={state.handleOpenStandaloneShareLink}
        onCopyLink={state.handleCopyStandaloneShareLink}
      />
    </div>
  )
}

export function App() {
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">
        Checking session…
      </div>
    )
  }

  if (auth.state.status === "locked") {
    return <PasswordScreen error={auth.state.error} usernameRequired={auth.usernameRequired} onSubmit={auth.submitPassword} />
  }

  if (auth.state.user?.role === "admin") return <TooltipProvider><AdminPage /></TooltipProvider>

  return (
    <>
      <TooltipProvider>
        <AppDialogProvider>
          <ProtectedDownloadAlert />
          <Routes>
          {/* Rendered outside the layout: opened as a bare OAuth popup. */}
          <Route path="/oauth/openrouter/callback" element={<OpenRouterCallbackPage />} />
          <Route element={<KannaLayout />}>
            {/* On mobile the sidebar fills the screen at `/` (see
                KannaSidebar), so the projects page hides there and lives at
                `/home` instead. Desktop shows it at both paths. */}
            <Route path="/" element={<div className="hidden md:contents"><LocalProjectsPage /></div>} />
            <Route path="/home" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:sectionId" element={<Suspense fallback={null}><SettingsPage /></Suspense>} />
            <Route path="/chat/:chatId" element={<ChatPage />} />
            {/* A chat and its sub-chats as a graph, in the chat page's shell.
                Reached by URL only for now: nothing in the app links here. */}
            <Route path="/graph/:chatId" element={<ChatPage view="graph" />} />
            {/* A project's chats as a page: the sidebar, focused on it (see
                `routeProjectId` in KannaSidebar). What opening a channel
                shows on a phone. Like `/`, the sidebar is the whole page
                there; beside it on desktop goes what `/` shows. */}
            <Route path="/project/:projectId" element={<div className="hidden md:contents"><LocalProjectsPage /></div>} />
            <Route path="/terminal" element={<TerminalPage />} />
            {/* Every state of the Tasks and Workflow widgets, on made-up data. */}
            <Route path="/workflows" element={<Suspense fallback={null}><WorkflowsGalleryPage /></Suspense>} />
          </Route>
          </Routes>
        </AppDialogProvider>
      </TooltipProvider>
    </>
  )
}

function ProtectedDownloadAlert() {
  const dialog = useAppDialog()
  useEffect(() => {
    let alertOpen = false
    const onDownloadError = () => {
      if (alertOpen) return
      alertOpen = true
      void dialog.alert({ title: "Download failed", description: "Check your session and try again." }).finally(() => {
        alertOpen = false
      })
    }
    window.addEventListener("kanna:protected-download-error", onDownloadError)
    return () => window.removeEventListener("kanna:protected-download-error", onDownloadError)
  }, [dialog])
  return null
}
