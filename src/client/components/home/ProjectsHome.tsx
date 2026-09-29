import { forwardRef, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ComponentType, type ReactNode } from "react"
import { Building2, Download, Folder, LaptopMinimal, Loader2, Lock, Plus, Search, SquarePen, User } from "lucide-react"
import type { LocalProjectSummary } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import type { ProjectRequest } from "../../app/kannaStateHelpers"
import { formatRelativeTime } from "../../lib/formatters"
import { formatPathWithTilde } from "../../lib/pathUtils"
import { parseRepoRef, resolveCloneDestination } from "../../lib/project-fs"
import { cn } from "../../lib/utils"
import { openCommandPalette } from "../command-palette/CommandPalette"
import { GitHubIcon } from "../provider-icons"
import { Button } from "../ui/button"
import { Input } from "../ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { buildHomeGroups, type HomeItem, type HomeSource } from "./homeItems"
import { useGitHubRecentRepos } from "./useGitHubRecentRepos"

/**
 * The "/" page: every project, wherever it lives. Projects on this machine
 * and the account's GitHub repos share one search, one set of recency
 * groups and one row design (homeItems.ts merges them; a cloned repo is its
 * local row). Rows sit in rounded cards with hairlines, the same pattern as
 * Settings, the setup wizard and the sidebar.
 */

const LIST_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40"

/** Newly arrived GitHub rows fade in; later renders (filters, search) don't. */
const ARRIVAL_FADE_MS = 600

function parentFolder(localPath: string) {
  const trimmed = localPath.replace(/\/+$/, "")
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/")) || "/"
  return formatPathWithTilde(parent)
}

function relativeTime(timeMs: number | undefined) {
  return timeMs === undefined ? null : formatRelativeTime(new Date(timeMs).toISOString())
}

/**
 * One row, the same parts for both sources: icon, name, one line of
 * context, a fact, the time, and the action it will take.
 */
const HomeRow = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  icon: ComponentType<{ className?: string }>
  title: string
  context: ReactNode
  fact?: string | null
  time: string | null
  action: ComponentType<{ className?: string }>
  loading: boolean
  tooltip: ReactNode
  arrived?: boolean
}>(function HomeRow({ icon: Icon, title, context, fact, time, action: Action, loading, tooltip, arrived, className, disabled, ...buttonProps }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...buttonProps}
          ref={ref}
          type="button"
          disabled={loading || disabled}
          className={cn(
            // A list cell: pressing darkens it at once, like a system list.
            "group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150",
            "hover:bg-muted/40 active:bg-muted/70",
            "disabled:cursor-not-allowed disabled:opacity-50",
            arrived && "animate-in fade-in duration-200",
            className,
          )}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{context}</span>
          </span>
          {fact ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{fact}</span> : null}
          {time ? <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{time}</span> : null}
          <span className="flex size-4 shrink-0 items-center justify-center">
            {loading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <Action className="size-4 text-muted-foreground opacity-0 transition-opacity duration-150 group-focus-visible:opacity-100 [@media(hover:hover)]:group-hover:opacity-100" />
            )}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
})

function FilterPill({ label, icon, selected, onClick }: {
  label: string
  icon?: ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors duration-150",
        selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function ProjectsHome({
  machineName,
  projects,
  repoKeyByPath,
  startingLocalPath,
  commandError,
  onOpenProject,
  renderProjectMenu,
  setup,
  socket,
  newProjectsDirectory,
  onCloneRepo,
}: {
  machineName: string
  projects: LocalProjectSummary[]
  /** Each local project's GitHub remote (homeItems.repoKey), to show a clone once. */
  repoKeyByPath: Map<string, string>
  startingLocalPath: string | null
  commandError: string | null
  onOpenProject: (localPath: string) => Promise<void>
  renderProjectMenu: (project: LocalProjectSummary, row: ReactNode) => ReactNode
  /** The setup entry (renders itself only while onboarding is unfinished). */
  setup?: ReactNode
  socket: KannaSocket
  newProjectsDirectory: string
  /** Kanna's create-project flow; navigates to the new chat on success. */
  onCloneRepo: (project: ProjectRequest) => Promise<void>
}) {
  const [query, setQuery] = useState("")
  const [source, setSource] = useState<HomeSource>("all")
  const [account, setAccount] = useState("all")
  const [cloningRepo, setCloningRepo] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)

  const { result, signedIn } = useGitHubRecentRepos(socket)
  const repos = useMemo(() => (result?.available ? result.repos : []), [result])
  const hasRepos = repos.length > 0

  const arrivedAtRef = useRef<number | null>(null)
  if (hasRepos && arrivedAtRef.current === null) arrivedAtRef.current = Date.now()
  const reposJustArrived = arrivedAtRef.current !== null && Date.now() - arrivedAtRef.current < ARRIVAL_FADE_MS

  // Personal account first, then organizations alphabetically.
  const accounts = useMemo(() => {
    const owners = [...new Set(repos.map((repo) => repo.owner).filter(Boolean))]
    const login = result?.login
    const rest = owners.filter((owner) => owner !== login).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    return login && owners.includes(login) ? [login, ...rest] : rest
  }, [repos, result?.login])

  const groups = useMemo(
    () => buildHomeGroups({ projects, repos, repoKeyByPath, source: hasRepos ? source : "local", account, query }),
    [projects, repos, repoKeyByPath, source, hasRepos, account, query],
  )

  const handleClone = async (nameWithOwner: string) => {
    if (cloningRepo !== null) return
    const ref = parseRepoRef(nameWithOwner)
    if (!ref) return
    const destination = resolveCloneDestination(newProjectsDirectory, ref)
    setCloningRepo(nameWithOwner)
    setCloneError(null)
    try {
      await onCloneRepo({
        mode: "clone",
        localPath: destination.localPath,
        fallbackPath: destination.fallbackPath,
        title: destination.title,
        cloneUrl: ref.cloneUrl,
      })
    } catch (error) {
      setCloneError(error instanceof Error ? error.message : String(error))
    } finally {
      setCloningRepo(null)
    }
  }

  const renderItem = (item: HomeItem) => {
    if (item.kind === "local") {
      const { project } = item
      return renderProjectMenu(project, (
        <HomeRow
          key={item.key}
          icon={Folder}
          title={item.title}
          context={parentFolder(project.localPath)}
          fact={project.chatCount > 0 ? `${project.chatCount} ${project.chatCount === 1 ? "chat" : "chats"}` : null}
          time={relativeTime(item.timeMs)}
          action={SquarePen}
          loading={startingLocalPath === project.localPath}
          tooltip={<p>{project.localPath}</p>}
          onClick={() => {
            void onOpenProject(project.localPath)
          }}
        />
      ))
    }
    const { repo } = item
    const ref = parseRepoRef(repo.nameWithOwner)
    const destination = ref ? formatPathWithTilde(resolveCloneDestination(newProjectsDirectory, ref).localPath) : null
    return (
      <HomeRow
        key={item.key}
        icon={repo.isPrivate ? Lock : GitHubIcon}
        title={item.title}
        context={repo.owner}
        time={relativeTime(item.timeMs)}
        action={Download}
        loading={cloningRepo === repo.nameWithOwner}
        disabled={cloningRepo !== null && cloningRepo !== repo.nameWithOwner}
        arrived={reposJustArrived}
        tooltip={(
          <>
            <p>{repo.nameWithOwner}{repo.isPrivate ? " · private" : ""}</p>
            {repo.description ? <p className="max-w-72 text-muted-foreground">{repo.description}</p> : null}
            {destination ? <p className="text-muted-foreground">Clone to {destination}</p> : null}
          </>
        )}
        onClick={() => {
          void handleClone(repo.nameWithOwner)
        }}
      />
    )
  }

  const searching = query.trim().length > 0
  const nothingYet = projects.length === 0 && !hasRepos

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-10 pt-16">
      <div className="mb-6 flex items-end justify-between gap-4">
        <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
        <span className="flex min-w-0 items-center gap-1.5 pb-1 text-sm text-muted-foreground">
          <LaptopMinimal className="size-4 shrink-0" />
          <span className="truncate">{machineName}</span>
        </span>
      </div>

      {setup}

      <div className="mb-3 flex items-center gap-2">
        <Input
          type="search"
          aria-label="Search projects"
          placeholder={hasRepos ? "Search projects and repos…" : "Search projects…"}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1"
        />
        <Button variant="default" size="sm" className="gap-2" onClick={() => openCommandPalette("add-project")}>
          <Plus className="size-3.5" data-icon="inline-start" />
          Add
        </Button>
      </div>

      {hasRepos ? (
        <div className="mb-6 flex flex-wrap items-center gap-1.5">
          <FilterPill label="All" selected={source === "all"} onClick={() => setSource("all")} />
          <FilterPill label="This Mac" icon={<LaptopMinimal className="size-3" />} selected={source === "local"} onClick={() => setSource("local")} />
          <FilterPill label="GitHub" icon={<GitHubIcon className="size-3" />} selected={source === "github"} onClick={() => setSource("github")} />
          {source === "github" && accounts.length > 1 ? (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              <FilterPill label="Everyone" selected={account === "all"} onClick={() => setAccount("all")} />
              {accounts.map((owner) => (
                <FilterPill
                  key={owner}
                  label={owner}
                  icon={owner === result?.login
                    ? <User className="size-3" aria-label="Personal account" />
                    : <Building2 className="size-3" aria-label="Organization" />}
                  selected={account === owner}
                  onClick={() => setAccount(owner)}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : (
        <div className="mb-6" />
      )}

      <div className="flex flex-col gap-6">
        {groups.map((group) => (
          <section key={group.key} aria-labelledby={`home-group-${group.key}`}>
            <h2
              id={`home-group-${group.key}`}
              className="mb-2 px-1 text-[13px] font-medium uppercase tracking-wider text-muted-foreground"
            >
              {group.title}
            </h2>
            <div className={LIST_CLASS}>{group.items.map(renderItem)}</div>
          </section>
        ))}

        {groups.length === 0 ? (
          <div className={cn(LIST_CLASS, "px-4 py-6 text-center text-sm text-muted-foreground")}>
            {nothingYet ? "No projects yet. Add a folder or clone a repo to start." : "Nothing matches."}
          </div>
        ) : null}

        {/* The recent list is a slice of GitHub: past it, the palette searches all of it. */}
        {searching && signedIn && source !== "local" ? (
          <div className={LIST_CLASS}>
            <button
              type="button"
              onClick={() => openCommandPalette("clone-github")}
              className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground active:bg-muted/70"
            >
              <Search className="size-4 shrink-0" />
              Search all of GitHub
            </button>
          </div>
        ) : null}
      </div>

      {commandError || cloneError ? (
        <div className="mt-4 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {commandError ?? cloneError}
        </div>
      ) : null}
    </div>
  )
}
