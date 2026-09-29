import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowUpRight, Check, Copy, RefreshCw } from "lucide-react"
import { renderSVG } from "uqr"
import { copyTextToClipboard } from "../../lib/clipboard"
import { displayClaimUrl, type PairSessionState } from "../../lib/pairSession"
import { cn } from "../../lib/utils"

const FLEET_URL = "https://kanna.sh/fleet"

/** Presses in a touch (scale 0.97) so the button feels like it heard you. */
export const PRIMARY_ACTION_CLASS =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-[transform,background-color] duration-150 ease-out hover:bg-primary/90 active:scale-[0.97]"

/**
 * QR for the claim URL. Always dark-on-white regardless of theme — phone
 * cameras want the contrast, and an inverted code doesn't scan everywhere.
 */
function ClaimQr({ url }: { url: string }) {
  const svg = useMemo(() => renderSVG(url, { ecc: "M", border: 2, pixelSize: 8 }), [url])
  return (
    <div
      className="mx-auto w-[152px] rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5 [&>svg]:h-full [&>svg]:w-full"
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
 * Copy, then a check for a moment. The two icons cross-fade with a touch of
 * blur and scale, so the swap reads as one icon changing, not two popping.
 */
function CopyLinkButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const iconClass = "absolute inset-0 m-auto size-3.5 transition-[opacity,transform,filter] duration-150 ease-out"
  return (
    <button
      type="button"
      title={copied ? "Copied" : "Copy link"}
      aria-label={copied ? "Copied" : "Copy link"}
      onClick={() => {
        void copyTextToClipboard(text).then((ok) => {
          if (!ok) return
          setCopied(true)
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setCopied(false), 1600)
        })
      }}
      className="relative size-7 shrink-0 rounded-full text-muted-foreground transition-[transform,background-color,color] duration-150 ease-out hover:bg-foreground/5 hover:text-foreground active:scale-[0.92]"
    >
      <Copy className={cn(iconClass, copied ? "scale-50 opacity-0 blur-[2px]" : "scale-100 opacity-100")} />
      <Check className={cn(iconClass, "text-emerald-500", copied ? "scale-100 opacity-100" : "scale-50 opacity-0 blur-[2px]")} />
    </button>
  )
}

/**
 * The claim URL as a link and a QR, plus every state the session can be in.
 * Shared by the sidebar's setup dialog and the onboarding wizard's Kanna
 * Cloud step. The wizard puts its own Open button in its footer, so it
 * passes `showOpenButton={false}` rather than showing two primary actions.
 */
export function CloudPairPanel({
  session,
  starting,
  onRetry,
  showOpenButton = true,
}: {
  session: PairSessionState
  starting: boolean
  onRetry: () => void
  showOpenButton?: boolean
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
    <div className="flex flex-col items-center gap-4">
      <ClaimQr url={claimUrl} />

      <div className="flex h-9 max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 pl-3.5 pr-1">
        <a
          href={claimUrl}
          target="_blank"
          rel="noreferrer"
          className="min-w-0 truncate font-mono text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          {displayClaimUrl(claimUrl)}
        </a>
        <CopyLinkButton text={claimUrl} />
      </div>

      {showOpenButton ? (
        <a href={claimUrl} target="_blank" rel="noreferrer" className={cn(PRIMARY_ACTION_CLASS, "mt-1 w-full")}>
          Open link & sign in
          <ArrowUpRight className="h-4 w-4" />
        </a>
      ) : null}
    </div>
  )
}
