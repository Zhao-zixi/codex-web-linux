import type { GitHubRepoSummary, LocalProjectSummary } from "../../../shared/types"
import { parseRepoRef } from "../../lib/project-fs"
import { filterProjects, getLocalProjectTitle, groupByRecency, type RecencyGroup } from "../../lib/project-groups"

/**
 * The "/" page's one list: projects on this machine and the signed-in
 * account's GitHub repos, in the same recency groups. A repo that's already
 * cloned is one project, shown once, as its local row.
 */

export type HomeSource = "all" | "local" | "github"

export type HomeItem =
  | { kind: "local"; key: string; title: string; timeMs?: number; project: LocalProjectSummary }
  | { kind: "github"; key: string; title: string; timeMs?: number; repo: GitHubRepoSummary }

/** "owner/repo", lowercased, from a remote URL or `owner/repo`; null when it isn't one. */
export function repoKey(value: string | undefined): string | null {
  if (!value) return null
  const ref = parseRepoRef(value)
  return ref ? `${ref.owner}/${ref.repo}`.toLowerCase() : null
}

function repoMatches(repo: GitHubRepoSummary, query: string) {
  return repo.nameWithOwner.toLowerCase().includes(query)
    || (repo.description?.toLowerCase().includes(query) ?? false)
}

export function buildHomeGroups({
  projects,
  repos,
  repoKeyByPath,
  source,
  account,
  query,
  nowMs = Date.now(),
}: {
  projects: LocalProjectSummary[]
  repos: GitHubRepoSummary[]
  /** Each local project's GitHub remote, as `repoKey` gives it. */
  repoKeyByPath: Map<string, string>
  source: HomeSource
  /** GitHub owner to show, or "all". Applies to the GitHub filter only. */
  account: string
  query: string
  nowMs?: number
}): RecencyGroup<HomeItem>[] {
  const search = query.trim().toLowerCase()
  const reposByKey = new Map(repos.map((repo) => [repo.nameWithOwner.toLowerCase(), repo]))
  const cloned = new Set([...repoKeyByPath.values()].filter((key) => reposByKey.has(key)))
  const accountRepos = source === "github" && account !== "all"
    ? repos.filter((repo) => repo.owner === account)
    : repos

  const items: HomeItem[] = []

  // Local rows: every project, or under GitHub only the clones of the
  // repos being shown, so a cloned repo still appears there, once.
  const githubKeys = new Set(accountRepos.map((repo) => repo.nameWithOwner.toLowerCase()))
  const localProjects = source === "github"
    ? projects.filter((project) => githubKeys.has(repoKeyByPath.get(project.localPath) ?? ""))
    : source === "local" || source === "all" ? projects : []
  for (const project of filterProjects(localProjects, query)) {
    items.push({
      kind: "local",
      key: `local:${project.localPath}`,
      title: getLocalProjectTitle(project),
      timeMs: project.folderModifiedAt ?? project.lastOpenedAt,
      project,
    })
  }

  if (source !== "local") {
    for (const repo of accountRepos) {
      if (cloned.has(repo.nameWithOwner.toLowerCase())) continue
      if (search && !repoMatches(repo, search)) continue
      const pushedAt = repo.pushedAt ? Date.parse(repo.pushedAt) : Number.NaN
      items.push({
        kind: "github",
        key: `github:${repo.nameWithOwner}`,
        title: repo.nameWithOwner.split("/")[1] ?? repo.nameWithOwner,
        timeMs: Number.isFinite(pushedAt) ? pushedAt : undefined,
        repo,
      })
    }
  }

  return groupByRecency(
    items,
    (item) => item.timeMs,
    (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }),
    nowMs,
  )
}
