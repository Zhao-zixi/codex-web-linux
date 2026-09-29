import { describe, expect, test } from "bun:test"
import type { GitHubRepoSummary, LocalProjectSummary } from "../../../shared/types"
import { buildHomeGroups, repoKey } from "./homeItems"

const NOW = Date.parse("2026-09-29T12:00:00Z")
const HOUR = 60 * 60 * 1000

function project(localPath: string, hoursAgo: number): LocalProjectSummary {
  return { localPath, title: localPath.split("/").pop()!, source: "saved", chatCount: 1, folderModifiedAt: NOW - hoursAgo * HOUR }
}

function repo(nameWithOwner: string, hoursAgo: number, extra: Partial<GitHubRepoSummary> = {}): GitHubRepoSummary {
  return {
    nameWithOwner,
    owner: nameWithOwner.split("/")[0]!,
    description: null,
    pushedAt: new Date(NOW - hoursAgo * HOUR).toISOString(),
    isPrivate: false,
    ...extra,
  }
}

const PROJECTS = [project("/Users/j/Projects/kanna", 2), project("/Users/j/Projects/notes", 3)]
const REPOS = [
  repo("jakemor/kanna", 1),
  repo("superwall/superwall-ios", 5, { description: "Paywalls for iOS" }),
  repo("jakemor/old-thing", 24 * 60),
]
const REPO_KEYS = new Map([["/Users/j/Projects/kanna", "jakemor/kanna"]])

function titles(groups: ReturnType<typeof buildHomeGroups>) {
  return groups.map((group) => [group.title, group.items.map((item) => `${item.kind}:${item.title}`)])
}

describe("repoKey", () => {
  test("reads https, ssh and shorthand remotes the same way", () => {
    expect(repoKey("https://github.com/JakeMor/Kanna.git")).toBe("jakemor/kanna")
    expect(repoKey("git@github.com:jakemor/kanna.git")).toBe("jakemor/kanna")
    expect(repoKey("jakemor/kanna")).toBe("jakemor/kanna")
    expect(repoKey(undefined)).toBeNull()
  })
})

describe("buildHomeGroups", () => {
  test("All merges both sources into the same recency groups, a cloned repo once", () => {
    const groups = buildHomeGroups({ projects: PROJECTS, repos: REPOS, repoKeyByPath: REPO_KEYS, source: "all", account: "all", query: "", nowMs: NOW })
    expect(titles(groups)).toEqual([
      ["Recent", ["local:kanna", "local:notes", "github:superwall-ios"]],
      ["Last 90 days", ["github:old-thing"]],
    ])
  })

  test("This Mac shows only local projects", () => {
    const groups = buildHomeGroups({ projects: PROJECTS, repos: REPOS, repoKeyByPath: REPO_KEYS, source: "local", account: "all", query: "", nowMs: NOW })
    expect(titles(groups)).toEqual([["Recent", ["local:kanna", "local:notes"]]])
  })

  test("GitHub shows the repos, a cloned one as its local project, filtered by account", () => {
    const all = buildHomeGroups({ projects: PROJECTS, repos: REPOS, repoKeyByPath: REPO_KEYS, source: "github", account: "all", query: "", nowMs: NOW })
    expect(titles(all)).toEqual([
      ["Recent", ["local:kanna", "github:superwall-ios"]],
      ["Last 90 days", ["github:old-thing"]],
    ])
    const superwall = buildHomeGroups({ projects: PROJECTS, repos: REPOS, repoKeyByPath: REPO_KEYS, source: "github", account: "superwall", query: "", nowMs: NOW })
    expect(titles(superwall)).toEqual([["Recent", ["github:superwall-ios"]]])
  })

  test("search filters both sources, repos by name or description", () => {
    const groups = buildHomeGroups({ projects: PROJECTS, repos: REPOS, repoKeyByPath: REPO_KEYS, source: "all", account: "all", query: "paywall", nowMs: NOW })
    expect(titles(groups)).toEqual([["Recent", ["github:superwall-ios"]]])
  })
})
