import { forwardRef, useMemo, useRef, useState, type ComponentPropsWithoutRef, type ComponentType, type ReactNode } from "react"
import { Building2, Check, Download, Folder, LaptopMinimal, Layers, ListFilter, Loader2, Lock, Plus, Search, SquarePen, User, Users, X } from "lucide-react"
import type { LocalProjectSummary } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import type { ProjectRequest } from "../../app/kannaStateHelpers"
import { formatRelativeTime } from "../../lib/formatters"
import { formatPathWithTilde } from "../../lib/pathUtils"
import { parseRepoRef, resolveCloneDestination } from "../../lib/project-fs"
import { cn } from "../../lib/utils"
import { openCommandPalette } from "../command-palette/CommandPalette"
import { SettingsGroupHeading } from "../../app/settings/shared"
import { PopoverMenuItem } from "../chat-ui/ChatPreferenceControls"
import { GitHubIcon } from "../provider-icons"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { buildHomeGroups, type HomeItem, type HomeSource } from "./homeItems"
import { useGitHubRecentRepos } from "./useGitHubRecentRepos"

/**
 * The "/" page: every project, wherever it lives. Projects on this machine
 * and the account's GitHub repos share one search, one set of recency
 * groups and one row design (homeItems.ts merges them; a cloned repo is its
 * local row). Search gets a card of its own; each recency group is a titled
 * card below it, as in Settings.
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
 * One row, the same parts for both sources: icon (the action it will take,
 * on hover), name, one line of context, a fact, and the time.
 */
const HomeRow = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  icon: ComponentType<{ className?: string }>
  title: string
  /** Marks the row, like a private repo's lock, right after the title. */
  badge?: ReactNode
  context: ReactNode
  fact?: string | null
  time: string | null
  action: ComponentType<{ className?: string }>
  loading: boolean
  tooltip: ReactNode
  arrived?: boolean
}>(function HomeRow({ icon: Icon, title, badge, context, fact, time, action: Action, loading, tooltip, arrived, className, disabled, ...buttonProps }, ref) {
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
            "group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-[background-color,opacity] duration-150 ease-snappy",
            "hover:bg-muted/40 active:bg-muted/70",
            "disabled:cursor-not-allowed disabled:opacity-50",
            arrived && "starting:opacity-0",
            className,
          )}
        >
          {/* The action takes the icon's place on hover instead of holding an
              empty slot at the row's end. Blur and a small scale blend the
              swap into one change rather than two icons crossing. */}
          <span className="relative flex size-4 shrink-0 items-center justify-center">
            {loading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <>
                <Icon className={cn(
                  "size-4 text-muted-foreground transition-[opacity,filter,scale] duration-150 ease-snappy",
                  "group-enabled:group-focus-visible:scale-75 group-enabled:group-focus-visible:opacity-0 group-enabled:group-focus-visible:blur-[1px]",
                  "[@media(hover:hover)]:group-enabled:group-hover:scale-75 [@media(hover:hover)]:group-enabled:group-hover:opacity-0 [@media(hover:hover)]:group-enabled:group-hover:blur-[1px]",
                )} />
                <Action className={cn(
                  "absolute size-4 scale-75 text-foreground opacity-0 blur-[1px] transition-[opacity,filter,scale] duration-150 ease-snappy",
                  "group-enabled:group-focus-visible:scale-100 group-enabled:group-focus-visible:opacity-100 group-enabled:group-focus-visible:blur-none",
                  "[@media(hover:hover)]:group-enabled:group-hover:scale-100 [@media(hover:hover)]:group-enabled:group-hover:opacity-100 [@media(hover:hover)]:group-enabled:group-hover:blur-none",
                )} />
              </>
            )}
          </span>
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="truncate text-sm font-medium text-foreground">{title}</span>
            {badge}
            <span className="truncate text-xs text-muted-foreground">{context}</span>
          </span>
          {fact ? <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{fact}</span> : null}
          {time ? <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{time}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
})

/**
 * An icon button inside the search card. The card is rounded-2xl (16px) and
 * the button sits 8px in from its edge, so rounded-lg (8px) keeps the two
 * corners concentric.
 */
const AccessoryButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button"> & {
  label: string
  active?: boolean
}>(function AccessoryButton({ label, active, className, children, ...buttonProps }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          {...buttonProps}
          ref={ref}
          type="button"
          aria-label={label}
          className={cn(
            "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground",
            "transition-[background-color,color,transform] duration-150 ease-snappy hover:bg-muted hover:text-foreground active:scale-[0.96]",
            "data-[state=open]:bg-muted data-[state=open]:text-foreground",
            active && "text-foreground",
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
})

function FilterSubheader({ children }: { children: ReactNode }) {
  return <div className="bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">{children}</div>
}

function FilterOption({ label, icon, selected, onSelect }: {
  label: string
  icon: ReactNode
  selected: boolean
  onSelect: () => void
}) {
  return (
    <PopoverMenuItem
      onClick={onSelect}
      selected={selected}
      icon={icon}
      label={label}
      trailing={selected ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    />
  )
}

/**
 * Which projects the list shows, behind one icon. Picking an account also
 * switches to GitHub, since accounts only narrow GitHub. The popover stays
 * open so a source and an account can be picked in one visit.
 */
function HomeFilterPopover({ source, account, accounts, login, onChange }: {
  source: HomeSource
  account: string
  accounts: string[]
  login: string | undefined
  onChange: (next: { source: HomeSource; account: string }) => void
}) {
  const filtered = source !== "all"
  const shownAccount = source === "github" ? account : null
  return (
    <Popover>
      <PopoverTrigger asChild>
        <AccessoryButton label="Filter projects" active={filtered}>
          <ListFilter className="size-4" />
          {/* The filter lives out of sight, so the icon says when it's on. */}
          {filtered ? <span aria-hidden className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" /> : null}
        </AccessoryButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-60 overflow-hidden p-0"
      >
        <div className="max-h-96 overflow-y-auto divide-y divide-border/60">
          <FilterSubheader>Show</FilterSubheader>
          <FilterOption label="Everything" icon={<Layers className="size-4" />} selected={source === "all"} onSelect={() => onChange({ source: "all", account: "all" })} />
          <FilterOption label="This Mac" icon={<LaptopMinimal className="size-4" />} selected={source === "local"} onSelect={() => onChange({ source: "local", account: "all" })} />
          <FilterOption label="GitHub" icon={<GitHubIcon className="size-4" />} selected={source === "github"} onSelect={() => onChange({ source: "github", account })} />
          {accounts.length > 1 ? (
            <>
              <FilterSubheader>GitHub account</FilterSubheader>
              <FilterOption label="Everyone" icon={<Users className="size-4" />} selected={shownAccount === "all"} onSelect={() => onChange({ source: "github", account: "all" })} />
              {accounts.map((owner) => (
                <FilterOption
                  key={owner}
                  label={owner}
                  icon={owner === login ? <User className="size-4" /> : <Building2 className="size-4" />}
                  selected={shownAccount === owner}
                  onSelect={() => onChange({ source: "github", account: owner })}
                />
              ))}
            </>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function searchPlaceholder(hasRepos: boolean, source: HomeSource, account: string) {
  if (!hasRepos || source === "local") return "Search projects…"
  if (source === "github") return account === "all" ? "Search GitHub repos…" : `Search ${account}’s repos…`
  return "Search projects and repos…"
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
        icon={GitHubIcon}
        title={item.title}
        badge={repo.isPrivate ? <Lock aria-label="Private" className="size-3 shrink-0 self-center text-muted-foreground" /> : null}
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

  // The recent list is a slice of GitHub: past it, the palette searches all
  // of it. It closes whichever card is last.
  const githubSearchRow = searching && signedIn && source !== "local" ? (
    <button
      type="button"
      onClick={() => openCommandPalette("clone-github")}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground active:bg-muted/70"
    >
      <Search className="size-4 shrink-0" />
      Search all of GitHub
    </button>
  ) : null

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

      <div className="flex flex-col gap-8">
        <div className="flex h-12 items-center gap-1 rounded-2xl border border-border bg-card/40 pl-4 pr-2">
          <Search className="mr-1.5 size-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            aria-label="Search projects"
            placeholder={searchPlaceholder(hasRepos, source, account)}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setQuery("")
            }}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <AccessoryButton label="Clear search" onClick={() => setQuery("")}>
              <X className="size-3.5" />
            </AccessoryButton>
          ) : null}
          {hasRepos ? (
            <HomeFilterPopover
              source={source}
              account={account}
              accounts={accounts}
              login={result?.login}
              onChange={(next) => {
                setSource(next.source)
                setAccount(next.account)
              }}
            />
          ) : null}
          <AccessoryButton label="Add project" onClick={() => openCommandPalette("add-project")}>
            <Plus className="size-4" />
          </AccessoryButton>
        </div>

        {groups.map((group, index) => (
          <section key={group.key} aria-label={group.title}>
            <SettingsGroupHeading>{group.title}</SettingsGroupHeading>
            <div className={LIST_CLASS}>
              {group.items.map(renderItem)}
              {index === groups.length - 1 ? githubSearchRow : null}
            </div>
          </section>
        ))}

        {groups.length === 0 ? (
          <div className={LIST_CLASS}>
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              {nothingYet ? "No projects yet. Add a folder or clone a repo to start." : "Nothing matches."}
            </div>
            {githubSearchRow}
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
