import { useEffect, useState } from "react"
import type { GitHubRecentReposResult } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import { useAuthService } from "../../stores/providerAuthStore"

/**
 * The signed-in `gh` account's recently pushed repos, for the "/" page. null
 * while they load; `available: false` when GitHub isn't connected. Refetches
 * whenever GitHub's sign-in flips (the setup wizard just connected it), so
 * the repos appear without a reload.
 */
export function useGitHubRecentRepos(socket: KannaSocket) {
  const [result, setResult] = useState<GitHubRecentReposResult | null>(null)
  const ghAuthStatus = useAuthService("gh")?.authStatus

  useEffect(() => {
    let cancelled = false
    socket.command<GitHubRecentReposResult>({ type: "github.listRecentRepos" })
      .then((repos) => {
        if (!cancelled) setResult(repos)
      })
      .catch(() => {
        if (!cancelled) setResult({ available: false, repos: [] })
      })
    return () => {
      cancelled = true
    }
  }, [socket, ghAuthStatus])

  return { result, signedIn: ghAuthStatus === "signed_in" }
}
