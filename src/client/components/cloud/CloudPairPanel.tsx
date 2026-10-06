import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { ArrowUpRight, Check, Copy, RefreshCw } from "lucide-react"
import { copyTextToClipboard } from "../../lib/clipboard"
import { displayClaimUrl, type PairSessionState } from "../../lib/pairSession"
import { cn } from "../../lib/utils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"

const FLEET_URL = "https://kanna.sh/fleet"

/**
 * Presses in a touch (scale 0.97) so the button feels like it heard you. The
 * transition names `scale` because that is the property Tailwind's scale
 * utilities set; with `transform` listed the press snapped.
 */
export const PRIMARY_ACTION_CLASS =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-[scale,background-color,opacity] duration-150 ease-snappy hover:bg-primary/90 active:scale-[0.97]"

/** The arrow leans the way the link goes: out of the app. */
const OUTBOUND_ARROW_CLASS =
  "h-4 w-4 transition-transform duration-150 ease-snappy motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"

/**
 * How long after the page comes back into view a held change shows. Long
 * enough for the eye to land on the panel before it moves.
 */
const RETURN_BEAT_MS = 250

/**
 * Pairing is finished in another tab, so the session usually turns paired
 * while this page is hidden, and the change would play to nobody. This holds
 * the last value seen until the page is back in view.
 */
function useHeldWhileHidden<T>(value: T): T {
  const [shown, setShown] = useState(value)
  // Layout effect: while the page is visible, `shown` follows `value` before
  // the next paint, so the panel is never a frame behind its other props.
  useLayoutEffect(() => {
    if (document.visibilityState === "visible") {
      setShown(value)
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return
      timer = setTimeout(() => setShown(value), RETURN_BEAT_MS)
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange)
      clearTimeout(timer)
    }
  }, [value])
  return shown
}

/**
 * Swaps the panel's views (motion in index.css, under "Kanna Cloud pairing").
 * The old view stays for its short fade, inert and laid over the new one,
 * and the box glides to the new view's height.
 *
 * The first view doesn't animate: the dialog or wizard step it sits in is
 * already arriving.
 */
function ViewSwap({ viewKey, children }: { viewKey: string; children: ReactNode }) {
  const [current, setCurrent] = useState(viewKey)
  const [leaving, setLeaving] = useState<{ key: string; node: ReactNode } | null>(null)
  const [swapped, setSwapped] = useState(false)
  // What the current view last rendered, so it can leave looking as it did
  // rather than re-rendered from the session that replaced it.
  const lastChildren = useRef(children)
  const innerRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<number | null>(null)

  if (viewKey !== current) {
    setLeaving({ key: current, node: lastChildren.current })
    setCurrent(viewKey)
    setSwapped(true)
  }

  useEffect(() => {
    lastChildren.current = children
  })

  // The leaving view is out of flow, so this is always the new view's height.
  useLayoutEffect(() => {
    const inner = innerRef.current
    if (!inner) return
    const measure = () => setHeight(inner.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [])

  return (
    // The 4px the box gives up and the inner takes back leave room for focus
    // rings and the taller view's first frames inside the clip.
    <div className="cloud-pair-stage -m-1 overflow-clip" style={height === null ? undefined : { height }}>
      <div ref={innerRef} className="relative p-1">
        {leaving ? (
          <div
            key={leaving.key}
            inert
            aria-hidden
            className="cloud-pair-view-out pointer-events-none absolute inset-x-1 top-1"
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) setLeaving(null)
            }}
          >
            {leaving.node}
          </div>
        ) : null}
        <div key={viewKey} className={swapped ? "cloud-pair-view-in" : undefined}>
          {children}
        </div>
      </div>
    </div>
  )
}

/** The old two-step flow, kept for runs that can't pair in place. */
function ManualPairInstructions() {
  return (
    <ol className="cloud-pair-rows list-decimal space-y-2 pl-5 text-sm">
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
    <div className="cloud-pair-rows flex flex-col items-center gap-4 py-2 text-center">
      <div className="cloud-pair-badge relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15">
        <span aria-hidden className="cloud-pair-ring absolute inset-0 rounded-full border border-emerald-500/60" />
        {/* Lucide's check, with its path turned round: it starts at the short
            stroke, so it draws the way a hand would. */}
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="cloud-pair-check h-5 w-5 text-emerald-500"
        >
          <path d="M4 12l5 5L20 6" pathLength={1} />
        </svg>
      </div>
      <p className="text-sm text-muted-foreground">
        This machine is live at <span className="font-medium text-foreground">{host}</span> — it stays
        reachable while kanna is running.
      </p>
      <a href={appOrigin} target="_blank" rel="noreferrer" className={cn(PRIMARY_ACTION_CLASS, "group")}>
        Open {host}
        <ArrowUpRight className={OUTBOUND_ARROW_CLASS} />
      </a>
    </div>
  )
}

/**
 * Copy, then a check for a moment. The two icons cross-fade with a touch of
 * blur and scale, so the swap reads as one icon changing, not two popping.
 */
function CopyLinkButton({ text, disabled = false }: { text: string; disabled?: boolean }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const iconClass = "absolute inset-0 m-auto size-3.5 transition-[opacity,scale,filter] duration-150 ease-snappy"
  return (
    <button
      type="button"
      disabled={disabled}
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
      className="relative size-7 shrink-0 rounded-full text-muted-foreground transition-[scale,background-color,color,opacity] duration-150 ease-snappy hover:bg-foreground/5 hover:text-foreground active:scale-[0.95] disabled:pointer-events-none disabled:opacity-0"
    >
      <Copy className={cn(iconClass, copied ? "scale-50 opacity-0 blur-[2px]" : "scale-100 opacity-100")} />
      <Check className={cn(iconClass, "text-emerald-500", copied ? "scale-100 opacity-100" : "scale-50 opacity-0 blur-[2px]")} />
    </button>
  )
}

/**
 * The claim URL, to open or to copy. It has this shape before the link
 * exists too, with a label where the URL will be and the actions waiting, so
 * the link arriving changes one line of text and nothing moves.
 */
function ClaimLink({ claimUrl, showOpenButton }: { claimUrl: string | undefined; showOpenButton: boolean }) {
  const ready = Boolean(claimUrl)
  const swapClass = "col-start-1 row-start-1 min-w-0 justify-self-start transition-[opacity,filter] duration-200 ease-snappy"
  const hiddenClass = "pointer-events-none opacity-0 blur-[2px]"
  return (
    <div className="cloud-pair-rows flex flex-col items-center gap-4">
      <div className="flex h-9 w-full items-center gap-1 rounded-full border border-border bg-muted/40 pl-3.5 pr-1">
        <div className="grid min-w-0 flex-1 items-center">
          <AnimatedShinyText
            // Stopped once the link is in: hidden, it would shimmer forever.
            animate={!ready}
            aria-hidden={ready}
            className={cn(swapClass, "mx-0 max-w-full text-xs", ready && hiddenClass)}
          >
            Getting your link…
          </AnimatedShinyText>
          <a
            href={claimUrl}
            target="_blank"
            rel="noreferrer"
            aria-hidden={!ready}
            className={cn(
              swapClass,
              "max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground",
              !ready && hiddenClass,
            )}
          >
            {claimUrl ? displayClaimUrl(claimUrl) : null}
          </a>
        </div>
        <CopyLinkButton text={claimUrl ?? ""} disabled={!ready} />
      </div>

      {showOpenButton ? (
        <a
          href={claimUrl}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!ready}
          className={cn(PRIMARY_ACTION_CLASS, "group mt-1 w-full", !ready && "pointer-events-none opacity-50")}
        >
          Open link & sign in
          <ArrowUpRight className={OUTBOUND_ARROW_CLASS} />
        </a>
      ) : null}
    </div>
  )
}

function RetryLink({ session, starting, onRetry }: { session: PairSessionState; starting: boolean; onRetry: () => void }) {
  return (
    <div className="cloud-pair-rows flex flex-col items-center gap-3 py-2 text-center">
      <p className="text-sm text-muted-foreground">
        {session.status === "expired"
          ? "That link expired."
          : `Couldn't reach kanna.sh${session.error ? ` (${session.error})` : ""}.`}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={starting}
        className={cn(PRIMARY_ACTION_CLASS, "disabled:opacity-60 disabled:active:scale-100")}
      >
        {/* Turns while the request is out, so the press is seen to be working. */}
        <RefreshCw className={cn("h-4 w-4", starting && "animate-spin")} />
        Get a new link
      </button>
    </div>
  )
}

type PairView = "link" | "paired" | "retry" | "manual"

function viewFor(session: PairSessionState): PairView {
  if (session.status === "paired" && session.appOrigin) return "paired"
  if (session.status === "unsupported") return "manual"
  if (session.status === "expired" || session.status === "error") return "retry"
  return "link"
}

/**
 * The claim URL as a link to open or copy, plus every state the session can
 * be in. Shared by the sidebar's setup dialog and the onboarding wizard's
 * Kanna Cloud step. The wizard puts its own Open button in its footer, so it
 * passes `showOpenButton={false}` rather than showing two primary actions.
 *
 * No QR: pairing is finished in a browser on this machine. The links are
 * `target="_blank"`, a new tab on the web and the default browser in Kanna
 * for Mac (macos/src/window.ts hands new windows to the system).
 */
export function CloudPairPanel({
  session: liveSession,
  starting,
  onRetry,
  showOpenButton = true,
}: {
  session: PairSessionState
  starting: boolean
  onRetry: () => void
  showOpenButton?: boolean
}) {
  const session = useHeldWhileHidden(liveSession)
  const view = viewFor(session)

  return (
    <ViewSwap viewKey={view}>
      {view === "paired" && session.appOrigin ? (
        <PairedSuccess appOrigin={session.appOrigin} />
      ) : view === "manual" ? (
        <ManualPairInstructions />
      ) : view === "retry" ? (
        <RetryLink session={session} starting={starting} onRetry={onRetry} />
      ) : (
        <ClaimLink
          claimUrl={session.status === "waiting" ? session.claimUrl : undefined}
          showOpenButton={showOpenButton}
        />
      )}
    </ViewSwap>
  )
}
