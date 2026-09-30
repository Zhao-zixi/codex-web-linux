import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { Ellipsis, ExternalLink, FolderOpen, Loader2, Search, Trash2, X } from "lucide-react"
import type {
  AgentProvider,
  GlobalSkillSummary,
  GlobalSkillsSnapshot,
  SkillInstallResult,
  SkillSearchResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../../../shared/types"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { PROVIDER_ICONS } from "../../components/chat-ui/ChatPreferenceControls"
import type { KannaState } from "../useKannaState"
import { cn } from "../../lib/utils"
import { SETTINGS_LIST_CARD_CLASS, SettingsActionButton, SettingsNotice } from "./shared"

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

function formatInstallCount(count: number) {
  if (!count || count <= 0) return "0 installs"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`
  return `${count} install${count === 1 ? "" : "s"}`
}

/** Raw harness icons for the providers that can invoke this skill (root-attributed). */
function SkillProviderIcons({ skillName, providers }: { skillName: string; providers: AgentProvider[] }) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
      {providers.map((provider) => {
        const Icon = PROVIDER_ICONS[provider]
        return (
          <Tooltip key={provider}>
            <TooltipTrigger asChild>
              <span
                aria-label={`${skillName} is available in ${PROVIDER_LABELS[provider]}`}
                className="inline-flex"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              {PROVIDER_LABELS[provider]}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** "/Users/jake/.claude/skills/foo/SKILL.md" → "~/.claude/skills/foo". */
function formatSkillLocation(skillPath: string) {
  return skillPath
    .replace(/\/SKILL\.md$/, "")
    .replace(/^.*?(?=\/\.(?:agents|claude|cursor|codex)\/)/, "~")
}

function GlobalSkillCard({
  skill,
  uninstalling,
  onUninstall,
  onRevealInFinder,
}: {
  skill: GlobalSkillSummary
  uninstalling: boolean
  onUninstall: () => void
  onRevealInFinder: (skillPath: string) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const href = skill.source ? `https://skills.sh/${skill.source}/${skill.name}` : null
  const description = skill.description || skill.source || skill.paths[0] || ""

  // Same trick as the widget rows' kebab: the "..." button synthesizes a contextmenu
  // event on the card so click and right-click share one menu.
  function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    cardRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
      view: window,
    }))
  }

  const card = (
    <div ref={cardRef} className="flex min-w-0 items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        {description ? (
          // Full-width rows fit most descriptions on one line; a narrow
          // column gets a second line rather than an ellipsis mid-sentence.
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground @2xl:line-clamp-1">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <SkillProviderIcons skillName={skill.name} providers={skill.providers} />
        <button
          type="button"
          aria-label={`Open actions for ${skill.name}`}
          onClick={openContextMenuFromButton}
          className="touch-manipulation flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          {uninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ellipsis className="h-4 w-4 shrink-0" />}
        </button>
      </div>
    </div>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
          {skill.source ? "Added via npx skills" : "Added by you"}
        </div>
        <ContextMenuSeparator />
        {skill.paths.map((skillPath) => (
          <ContextMenuItem
            key={skillPath}
            onSelect={() => onRevealInFinder(skillPath)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">
              {skill.paths.length > 1 ? `Open ${formatSkillLocation(skillPath)}` : "Open in Finder"}
            </span>
          </ContextMenuItem>
        ))}
        {href ? (
          <ContextMenuItem
            onSelect={() => {
              window.open(href, "_blank", "noreferrer")
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">View on skills.sh</span>
          </ContextMenuItem>
        ) : null}
        {skill.source ? (
          <ContextMenuItem
            disabled={uninstalling}
            onSelect={onUninstall}
            className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Uninstall</span>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function SkillResultCard({
  skill,
  installing,
  installed,
  message,
  onInstall,
}: {
  skill: SkillSearchResult
  installing: boolean
  installed: boolean
  message?: string
  onInstall: () => void
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-4 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        <div className="mt-0.5 truncate text-[13px] leading-5 text-muted-foreground">{skill.source} · {formatInstallCount(skill.installs)}</div>
        {installed && message ? <div className="mt-0.5 truncate text-xs text-emerald-500">{message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`https://skills.sh/${skill.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${skill.name} on skills.sh`}
          className="touch-manipulation inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <SettingsActionButton
          disabled={installing || installed}
          onClick={onInstall}
          icon={installing ? <Loader2 className="animate-spin" /> : null}
        >
          {installed ? "Installed" : installing ? "Installing" : "Get"}
        </SettingsActionButton>
      </div>
    </div>
  )
}

/** Labels the installed and skills.sh halves of the card while a search is on. */
function SkillsSubheader({ children }: { children: ReactNode }) {
  return <div className="bg-muted/40 px-4 py-1.5 text-xs text-slate-500 dark:text-slate-400">{children}</div>
}

function SkillsMessageRow({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <div className={cn("whitespace-pre-wrap break-words px-4 py-3 text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground")}>
      {children}
    </div>
  )
}

export function SkillsSection({
  state,
}: {
  state: Pick<KannaState, "connectionStatus" | "socket">
}) {
  const socket = state.socket
  const connectionStatus = state.connectionStatus
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installedSkills, setInstalledSkills] = useState<GlobalSkillSummary[]>([])
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(() => new Set())
  const [installedLoading, setInstalledLoading] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [uninstallingSkillId, setUninstallingSkillId] = useState<string | null>(null)
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({})
  // One query does both jobs: it filters what's installed right away and,
  // from two characters, searches skills.sh for more to add.
  const normalizedFilter = query.trim().toLowerCase()
  const filteredInstalledSkills = normalizedFilter
    ? installedSkills.filter((skill) =>
      [skill.name, skill.description, skill.source].some((field) => field?.toLowerCase().includes(normalizedFilter))
    )
    : installedSkills
  const searchingRegistry = query.trim().length >= 2

  async function loadInstalledSkills() {
    if (connectionStatus !== "connected") {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(null)
      setInstalledLoading(false)
      return
    }

    try {
      setInstalledLoading(true)
      setInstalledError(null)
      const snapshot = await socket.command<GlobalSkillsSnapshot>({ type: "skills.listGlobal" })
      setInstalledSkills(snapshot.skills)
      setInstalledSkillIds(new Set(snapshot.skills.map((skill) => skill.name)))
    } catch (error) {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(error instanceof Error ? error.message : "Unable to read installed skills.")
    } finally {
      setInstalledLoading(false)
    }
  }

  useEffect(() => {
    void loadInstalledSkills()
  }, [connectionStatus, socket])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      setResults([])
      setSearchError(null)
      setSearchLoading(false)
      return
    }

    if (connectionStatus !== "connected") {
      setResults([])
      setSearchLoading(false)
      setSearchError("Backend connection required.")
      return
    }

    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)

    const timeout = window.setTimeout(() => {
      void socket.command<SkillSearchSnapshot>({
        type: "skills.search",
        query: normalizedQuery,
        limit: 100,
      })
        .then((snapshot) => {
          if (cancelled) return
          setResults(snapshot.skills)
        })
        .catch((error) => {
          if (cancelled) return
          setResults([])
          setSearchError(error instanceof Error ? error.message : "Unable to search skills.")
        })
        .finally(() => {
          if (cancelled) return
          setSearchLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [connectionStatus, query, socket])

  async function installSkill(skill: SkillSearchResult) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }

    try {
      setInstallingSkillId(skill.id)
      setOperationError(null)
      setInstallMessages((current) => {
        const next = { ...current }
        delete next[skill.id]
        return next
      })
      await socket.command<SkillInstallResult>({
        type: "skills.install",
        source: skill.source,
        skillId: skill.skillId,
      })
      setInstalledSkillIds((current) => new Set(current).add(skill.skillId))
      setInstallMessages((current) => ({
        ...current,
        [skill.id]: "Installed globally",
      }))
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Install failed.")
    } finally {
      setInstallingSkillId(null)
    }
  }

  function revealSkillInFinder(skillPath: string) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }
    // Reveal the skill's directory rather than the SKILL.md file itself.
    const directory = skillPath.replace(/\/SKILL\.md$/, "")
    void socket.command({
      type: "system.openExternal",
      action: "open_finder",
      localPath: directory,
    }).catch((error) => {
      setOperationError(error instanceof Error ? error.message : "Unable to open in Finder.")
    })
  }

  async function uninstallSkill(skill: GlobalSkillSummary) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }

    try {
      setUninstallingSkillId(skill.name)
      setOperationError(null)
      await socket.command<SkillUninstallResult>({
        type: "skills.uninstall",
        skillId: skill.name,
      })
      setInstalledSkills((current) => current.filter((installedSkill) => installedSkill.name !== skill.name))
      setInstalledSkillIds((current) => {
        const next = new Set(current)
        next.delete(skill.name)
        return next
      })
      setInstallMessages((current) => {
        const next = { ...current }
        for (const key of Object.keys(next)) {
          if (key.endsWith(`/${skill.name}`) || key === skill.name) {
            delete next[key]
          }
        }
        return next
      })
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Uninstall failed.")
    } finally {
      setUninstallingSkillId(null)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {operationError ? <SettingsNotice className="font-mono text-xs">{operationError}</SettingsNotice> : null}
      <div className={SETTINGS_LIST_CARD_CLASS}>
        {/* The search field is the card's header row, on the card's own
            surface rather than a separate input box above it. */}
        <div className="flex h-11 items-center gap-2.5 px-4">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            aria-label="Filter installed skills or search skills.sh"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
            placeholder={installedSkills.length > 0
              ? `Filter ${installedSkills.length} installed, or add from skills.sh`
              : "Add skills from skills.sh"}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {searchLoading || installedLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
          {query ? (
            <button
              type="button"
              aria-label="Clear skills search"
              onClick={() => setQuery("")}
              className="touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        {installedError ? <SkillsMessageRow tone="error">{installedError}</SkillsMessageRow> : null}

        {searchingRegistry ? <SkillsSubheader>Installed</SkillsSubheader> : null}
        {filteredInstalledSkills.map((skill) => (
          <GlobalSkillCard
            key={skill.name}
            skill={skill}
            uninstalling={uninstallingSkillId === skill.name}
            onUninstall={() => { void uninstallSkill(skill) }}
            onRevealInFinder={revealSkillInFinder}
          />
        ))}
        {!installedLoading && !installedError && filteredInstalledSkills.length === 0 ? (
          <SkillsMessageRow>
            {installedSkills.length === 0
              ? "No global skills installed yet. Search above to add one."
              : `No installed skills match “${query.trim()}”.`}
          </SkillsMessageRow>
        ) : null}

        {searchingRegistry ? (
          <>
            <SkillsSubheader>From skills.sh</SkillsSubheader>
            {searchError ? <SkillsMessageRow tone="error">{searchError}</SkillsMessageRow> : null}
            {results.map((skill) => (
              <SkillResultCard
                key={skill.id}
                skill={skill}
                installing={installingSkillId === skill.id}
                installed={installedSkillIds.has(skill.skillId)}
                message={installMessages[skill.id]}
                onInstall={() => { void installSkill(skill) }}
              />
            ))}
            {!searchLoading && !searchError && results.length === 0 ? (
              <SkillsMessageRow>No skills found on skills.sh.</SkillsMessageRow>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}
