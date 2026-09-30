import { useEffect, useRef, useState, type ReactNode } from "react"
import { useSearchParams } from "react-router-dom"
import { ChevronRight, Cloud, ExternalLink, Flower, LaptopMinimal, Loader2, Settings2, Terminal, X } from "lucide-react"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { CloudMachineSummary } from "../../shared/cloud-api"
import { DEV_CLIENT_PORT, PROD_SERVER_PORT } from "../../shared/ports"
import { FLEET_URL } from "../app/MachineSwitcher"
import { SETTINGS_LIST_CARD_CLASS } from "../app/settings/shared"
import type { SocketStatus } from "../app/socket"
import { isMacApp, isOnThisMac, postToMacApp } from "../lib/macApp"
import { cn } from "../lib/utils"
import { findCurrentMachine, useConnectionStore } from "../stores/connectionStore"
import { CopyButton } from "./ui/copy-button"

/**
 * The "/" page's frame: while the server connects (or isn't running) it
 * explains how to start it; once connected it shows `children`, the
 * projects list (home/ProjectsHome.tsx).
 */
interface LocalDevProps {
  connectionStatus: SocketStatus
  ready: boolean
  children: ReactNode
}

function CodeBlock({ children }: { children: string }) {
  return (
    // Darker than the page, and led by a prompt glyph rather than a chevron,
    // which read as a card that expands.
    <div className="grid grid-cols-[1fr_auto] items-center bg-muted dark:bg-black/30 border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm text-left">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <Terminal className="inline h-4 w-4 text-muted-foreground" />
        <code>{children}</code>
      </pre>
      <CopyButton
        text={children}
        // Only the glyph brightens on hover: a box would frame a button
        // inside what is already a box.
        className="h-8 w-8 text-muted-foreground hover:text-foreground hover:!border-border/0 hover:!bg-transparent"
        copiedHoverReset={false}
      />
    </div>
  )
}

/**
 * Most connections land well inside this, so the connecting screen waits it
 * out before fading in rather than flashing for a frame on every load.
 */
const CONNECTING_REVEAL_DELAY_MS = 400

/**
 * How long attempts must keep failing before the page offers setup help.
 * A server that is still booting (Kanna for Mac starts it alongside the
 * window) refuses the first attempt or two; that is not a reason to tell
 * anyone to run a command.
 */
const SETUP_HELP_AFTER_MS = 1_500

/**
 * Whether the page should show setup help. The socket retries on a backoff,
 * so status cycles connecting → disconnected on every attempt. Once help is
 * showing it stays through the retries instead of swapping layouts each time,
 * until a connection lands.
 */
function useConnectionFailed(connectionStatus: SocketStatus) {
  const failingSinceRef = useRef<number | null>(null)
  const [failed, setFailed] = useState(false)
  if (connectionStatus === "connected") {
    failingSinceRef.current = null
    if (failed) setFailed(false)
  } else {
    failingSinceRef.current ??= Date.now()
    if (!failed && connectionStatus === "disconnected" && Date.now() - failingSinceRef.current > SETUP_HELP_AFTER_MS) {
      setFailed(true)
    }
  }
  return failed
}

/**
 * True when the connecting screen was on screen long enough to be seen, so
 * the page it hands over to fades in instead of cutting. A fast connection
 * shows the page as it would without this.
 */
function useRevealAfterWait(waiting: boolean) {
  const waitingSinceRef = useRef<number | null>(null)
  const revealRef = useRef(false)
  if (waiting) {
    waitingSinceRef.current ??= Date.now()
    revealRef.current = false
  } else if (waitingSinceRef.current !== null) {
    revealRef.current = Date.now() - waitingSinceRef.current > CONNECTING_REVEAL_DELAY_MS
    waitingSinceRef.current = null
  }
  return revealRef.current
}

/**
 * Who is reading the page decides what brings the server back. A browser on
 * the machine itself needs the command. Kanna for Mac restarts its own
 * server (macos/src/server-agent.ts), so a command there would only start a
 * second one. On a machine's kanna.sh address the reader is usually on
 * another device, and the machine is what went away.
 */
type ConnectHelpContext =
  | { kind: "local"; command: string; host: string | null }
  | { kind: "mac" }
  | { kind: "cloud"; machine: CloudMachineSummary | null; others: CloudMachineSummary[]; fromMacApp: boolean }

/**
 * The page reconnects to the port it was served from, so a server started
 * anywhere else never picks it back up. Name the port whenever it isn't the
 * default. The dev client's port is Vite's, not the server's, so it is left
 * out.
 */
function localStartCommand() {
  const port = Number(window.location.port)
  const customPort = port > 0 && port !== PROD_SERVER_PORT && port !== DEV_CLIENT_PORT
  return getCliInvocation(customPort ? `--port ${port}` : undefined)
}

function useConnectHelpContext(): ConnectHelpContext {
  const mode = useConnectionStore((state) => state.mode)
  const machines = useConnectionStore((state) => state.machines)
  const fromMacApp = useConnectionStore((state) => state.fromMacApp)
  const load = useConnectionStore((state) => state.load)

  // The sidebar's switcher normally runs this, but the sidebar is closed on
  // phones, which is where a machine's kanna.sh page is most often read.
  useEffect(() => {
    if (mode === "unknown") void load()
  }, [load, mode])

  if (isMacApp() && isOnThisMac()) return { kind: "mac" }
  if (mode === "cloud" && !isOnThisMac()) {
    const machine = findCurrentMachine(machines)
    return { kind: "cloud", machine, others: machines.filter((other) => other !== machine), fromMacApp }
  }
  return {
    kind: "local",
    command: localStartCommand(),
    host: isOnThisMac() ? null : window.location.hostname,
  }
}

function Command({ children }: { children: string }) {
  return <code className="font-mono text-[0.9em] text-foreground">{children}</code>
}

/** Worded for the whole retry loop, so it doesn't change between attempts; the spinner is the retrying. */
function RetryStatus({ children = "Trying again automatically" }: { children?: ReactNode }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin" />
      <span>{children}</span>
    </div>
  )
}

/** The Fleet page's wording (kanna-site `formatLastSeen`), so a machine reads the same in both places. */
function formatLastSeen(lastSeenAt: number) {
  const minutes = Math.floor((Date.now() - lastSeenAt) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function machineStatus(machine: CloudMachineSummary) {
  if (machine.kind === "e2b") return machine.online ? "Ready" : "Asleep"
  if (machine.online) return "Online"
  return machine.lastSeenAt === null ? "Never connected" : `Last seen ${formatLastSeen(machine.lastSeenAt)}`
}

const FLEET_ROW_CLASS = "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60"

/**
 * The account's other machines, so an offline one isn't a dead end. Every
 * row opens its machine, as Launch does on the Fleet page: an offline one
 * lands on this same page for that machine, which is still the right place.
 * Kanna for Mac switches machines itself (MachineSwitcher) and blocks plain
 * links to other origins, so there the rows ask the app.
 */
function FleetCard({ machines, fromMacApp }: { machines: CloudMachineSummary[]; fromMacApp: boolean }) {
  // Online first, then most recently seen, so the likeliest switch is on top.
  const sorted = [...machines].sort((a, b) =>
    Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
  )

  return (
    <div className={cn(SETTINGS_LIST_CARD_CLASS, "text-left")}>
      {sorted.map((machine) => {
        const content = (
          <>
            {/* In an icon-sized box, so the dots line up with Manage Fleet's icon. */}
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              <span className={cn("size-2 rounded-full", machine.online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600")} />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className={cn("truncate text-sm", machine.online ? "text-foreground" : "text-muted-foreground")}>
                {machine.name}
              </span>
              {machine.kind === "e2b" ? (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                  <Cloud className="size-2.5" />
                  Dev box
                </span>
              ) : null}
            </span>
            {/* Kept whole: a long name truncates instead. */}
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">{machineStatus(machine)}</span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" />
          </>
        )
        return fromMacApp ? (
          <button
            key={machine.subdomain}
            type="button"
            onClick={() => postToMacApp({ type: "openMachine", subdomain: machine.subdomain })}
            className={FLEET_ROW_CLASS}
          >
            {content}
          </button>
        ) : (
          <a key={machine.subdomain} href={machine.appOrigin} className={FLEET_ROW_CLASS}>
            {content}
          </a>
        )
      })}
      <button
        type="button"
        onClick={() => window.open(FLEET_URL, "_blank", "noopener")}
        className={cn(FLEET_ROW_CLASS, "text-sm text-muted-foreground hover:text-foreground")}
      >
        <Settings2 className="size-4 shrink-0" />
        <span className="flex-1">Manage Fleet</span>
        {/* Says it leaves the app, where the machine rows' chevrons are. */}
        <ExternalLink className="size-3.5 shrink-0 opacity-60" />
      </button>
    </div>
  )
}

function ConnectHelp({ context }: { context: ConnectHelpContext }) {
  let icon = <Flower className="size-7 text-muted-foreground" />
  let title: string
  let body: ReactNode
  let action: ReactNode = null
  let status: ReactNode = <RetryStatus />
  let footer: ReactNode = null

  if (context.kind === "mac") {
    title = `${APP_NAME} is restarting`
    body = `${APP_NAME} for Mac starts its server again on its own. This window picks up where you left off.`
  } else if (context.kind === "cloud") {
    const machine = context.machine
    const name = machine?.name ?? "This machine"
    icon = <LaptopMinimal className="size-7 text-muted-foreground" />
    // Dev-boxes pause when idle and wake on traffic, so this page's own
    // retries are what bring one back.
    if (machine?.kind === "e2b") {
      title = `Waking ${name}`
      body = "Dev boxes pause when nobody is using them. This takes a few seconds."
      status = <RetryStatus>Starting up</RetryStatus>
    } else {
      title = `${name} is offline`
      body = (
        <>
          Open {APP_NAME} on it, or run <Command>{getCliInvocation()}</Command> there.
          This page reconnects as soon as it's back.
        </>
      )
      const lastSeen = machine?.lastSeenAt ?? null
      if (lastSeen !== null) status = <RetryStatus>Last seen {formatLastSeen(lastSeen)}</RetryStatus>
    }
    footer = <FleetCard machines={context.others} fromMacApp={context.fromMacApp} />
  } else {
    title = `${APP_NAME} isn't running`
    body = context.host
      ? `Start it on ${context.host}. This page reconnects by itself.`
      : "Start it from any terminal on this machine. This page reconnects by itself."
    action = <CodeBlock>{context.command}</CodeBlock>
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="flex w-full max-w-md flex-col items-center gap-6 text-center transition-[opacity,translate] duration-300 ease-snappy starting:opacity-0 starting:translate-y-1 motion-reduce:starting:translate-y-0">
        <div className="flex size-14 items-center justify-center rounded-2xl border border-border bg-card">
          {icon}
        </div>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground text-balance">{title}</h1>
          <p className="text-sm leading-relaxed text-muted-foreground text-balance">{body}</p>
        </div>
        {action ? <div className="w-full">{action}</div> : null}
        {status}
        {footer ? <div className="w-full pt-4">{footer}</div> : null}
      </div>
    </div>
  )
}

function ConnectingNotice({ delayed }: { delayed: boolean }) {
  // A transient state, so it stays quiet: no page chrome, one line.
  // Hidden through the reveal delay so fast connections never show it.
  return (
    <div
      role="status"
      className="flex flex-1 flex-col items-center justify-center gap-3 px-6 transition-opacity duration-200 ease-snappy starting:opacity-0"
      style={delayed ? { transitionDelay: `${CONNECTING_REVEAL_DELAY_MS}ms` } : undefined}
    >
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
      <p className="text-sm text-muted-foreground">Connecting to {APP_NAME}…</p>
    </div>
  )
}

// `/home?preview=<variant>` shows this page's states while connected: they
// are hard to reach on purpose (a stopped server, an offline machine).
const PREVIEW_VARIANTS = ["local", "mac", "cloud", "devbox", "connecting"] as const
type PreviewVariant = typeof PREVIEW_VARIANTS[number]

const PREVIEW_MACHINE: CloudMachineSummary = {
  subdomain: "studio",
  name: "Studio Mac",
  appOrigin: "#",
  online: false,
  lastSeenAt: Date.now() - 2 * 60 * 60 * 1000,
}

/** Online and offline machines, and dev boxes both awake and paused. */
function previewFleet(): CloudMachineSummary[] {
  const now = Date.now()
  return [
    { subdomain: "mbp", name: "MacBook Pro", appOrigin: "#", online: true, lastSeenAt: now },
    { subdomain: "linux", name: "Linux Server", appOrigin: "#", online: false, lastSeenAt: now - 3 * 24 * 60 * 60 * 1000 },
    { subdomain: "box", name: "Agents Box", appOrigin: "#", online: true, lastSeenAt: now, kind: "e2b" },
    { subdomain: "scratch", name: "Scratch Box", appOrigin: "#", online: false, lastSeenAt: now - 40 * 60 * 1000, kind: "e2b" },
    { subdomain: "mini", name: "Mac mini", appOrigin: "#", online: false, lastSeenAt: null },
  ]
}

function previewContext(variant: Exclude<PreviewVariant, "connecting">): ConnectHelpContext {
  switch (variant) {
    case "local": return { kind: "local", command: localStartCommand(), host: null }
    case "mac": return { kind: "mac" }
    case "cloud": return { kind: "cloud", machine: PREVIEW_MACHINE, others: previewFleet(), fromMacApp: false }
    case "devbox": return {
      kind: "cloud",
      machine: { ...PREVIEW_MACHINE, name: "Dev Box", kind: "e2b" },
      others: previewFleet(),
      fromMacApp: false,
    }
  }
}

function PreviewBar({ variant, onChange, onClose }: {
  variant: PreviewVariant
  onChange: (variant: PreviewVariant) => void
  onClose: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-background/80 p-1 text-xs shadow-sm backdrop-blur">
        {PREVIEW_VARIANTS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={cn(
              "rounded-full px-2.5 py-1 capitalize text-muted-foreground transition-colors hover:text-foreground",
              option === variant && "bg-muted text-foreground"
            )}
          >
            {option}
          </button>
        ))}
        <button type="button" onClick={onClose} title="Close preview" className="rounded-full p-1 text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  )
}

export function LocalDev({
  connectionStatus,
  ready,
  children,
}: LocalDevProps) {
  const isConnected = connectionStatus === "connected" && ready
  const needsSetup = useConnectionFailed(connectionStatus)
  const revealChildren = useRevealAfterWait(!isConnected)
  const context = useConnectHelpContext()

  const [searchParams, setSearchParams] = useSearchParams()
  const previewParam = searchParams.get("preview")
  const preview = PREVIEW_VARIANTS.find((variant) => variant === previewParam) ?? null

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
      {preview ? (
        <>
          <PreviewBar
            variant={preview}
            onChange={(variant) => setSearchParams({ preview: variant }, { replace: true })}
            onClose={() => setSearchParams({}, { replace: true })}
          />
          {preview === "connecting"
            ? <ConnectingNotice key={preview} delayed={false} />
            : <ConnectHelp key={preview} context={previewContext(preview)} />}
        </>
      ) : isConnected ? (
        <div className={cn(revealChildren && "transition-opacity duration-200 ease-snappy starting:opacity-0")}>
          {children}
        </div>
      ) : !needsSetup ? (
        <ConnectingNotice delayed />
      ) : (
        <ConnectHelp context={context} />
      )}

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
