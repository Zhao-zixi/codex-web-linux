import { useMemo } from "react"
import { ArrowUpRight, Check, RefreshCw } from "lucide-react"
import { renderSVG } from "uqr"
import { displayClaimUrl, type PairSessionState } from "../../lib/pairSession"
import { CopyButton } from "../ui/copy-button"

const FLEET_URL = "https://kanna.sh/fleet"

const PRIMARY_ACTION_CLASS =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"

/**
 * QR for the claim URL. Always dark-on-white regardless of theme — phone
 * cameras want the contrast, and an inverted code doesn't scan everywhere.
 */
function ClaimQr({ url }: { url: string }) {
  const svg = useMemo(() => renderSVG(url, { ecc: "M", border: 2, pixelSize: 8 }), [url])
  return (
    <div
      className="mx-auto w-[172px] rounded-lg bg-white p-2 [&>svg]:h-full [&>svg]:w-full"
      // uqr returns a self-contained <svg> string built from the URL above.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

/** The old two-step flow, kept for runs that can't pair in place. */
function ManualPairInstructions() {
  return (
    <ol className="list-decimal space-y-2 pl-5 text-sm">
      <li>
        Sign in at{" "}
        <a
          href={FLEET_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium underline underline-offset-2"
        >
          kanna.sh/fleet
        </a>{" "}
        and add a machine to your Fleet.
      </li>
      <li>
        Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">bunx kanna pair &lt;code&gt;</code>{" "}
        in a terminal on this machine.
      </li>
    </ol>
  )
}

export function PairedSuccess({ appOrigin }: { appOrigin: string }) {
  const host = displayClaimUrl(appOrigin)
  return (
    <div className="space-y-4 py-2 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
        <Check className="h-5 w-5 text-emerald-500" />
      </div>
      <p className="text-sm text-muted-foreground">
        This machine is live at <span className="font-medium text-foreground">{host}</span> — it stays
        reachable while kanna is running.
      </p>
      <a href={appOrigin} target="_blank" rel="noreferrer" className={PRIMARY_ACTION_CLASS}>
        Open {host}
        <ArrowUpRight className="h-4 w-4" />
      </a>
    </div>
  )
}

/**
 * The claim URL as a link and a QR, plus every state the session can be in.
 * Shared by the sidebar's setup dialog and the onboarding wizard's last step.
 */
export function CloudPairPanel({
  session,
  starting,
  onRetry,
}: {
  session: PairSessionState
  starting: boolean
  onRetry: () => void
}) {
  const claimUrl = session.claimUrl ?? ""

  if (session.status === "paired" && session.appOrigin) {
    return <PairedSuccess appOrigin={session.appOrigin} />
  }

  if (session.status === "unsupported") {
    return <ManualPairInstructions />
  }

  if (session.status === "expired" || session.status === "error") {
    return (
      <div className="space-y-3 py-2 text-center">
        <p className="text-sm text-muted-foreground">
          {session.status === "expired"
            ? "That link expired."
            : `Couldn't reach kanna.sh${session.error ? ` (${session.error})` : ""}.`}
        </p>
        <button
          type="button"
          onClick={onRetry}
          disabled={starting}
          className={`${PRIMARY_ACTION_CLASS} disabled:opacity-60`}
        >
          <RefreshCw className="h-4 w-4" />
          Get a new link
        </button>
      </div>
    )
  }

  if (session.status !== "waiting" || !claimUrl) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Getting your link…</p>
  }

  return (
    <div className="space-y-4">
      <ClaimQr url={claimUrl} />

      <div className="flex items-center gap-2 overflow-hidden rounded-lg border bg-muted/40 px-3 py-2">
        <a
          href={claimUrl}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 flex-1 truncate font-mono text-xs hover:underline"
        >
          {displayClaimUrl(claimUrl)}
        </a>
        <CopyButton text={claimUrl} title="Copy link" />
      </div>

      <a href={claimUrl} target="_blank" rel="noreferrer" className={`${PRIMARY_ACTION_CLASS} flex`}>
        Open link & sign in
        <ArrowUpRight className="h-4 w-4" />
      </a>

      <p className="text-center text-xs text-muted-foreground">
        Or scan the code to do the whole thing on your phone. Sign in, pick a name — this machine
        comes online on its own.
      </p>
    </div>
  )
}
