import { useRef, useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowLeftRight,
  ChevronRight,
  CodeXml,
  Loader2,
  Monitor,
  Terminal,
} from "lucide-react"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { SocketStatus } from "../app/socket"
import { PageHeader } from "../app/PageHeader"
import { SettingsGroupHeading } from "../app/settings/shared"
import { cn } from "../lib/utils"
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
    <div className="grid grid-cols-[1fr_auto] items-center group bg-background border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <ChevronRight className="inline h-4 w-4 opacity-40" />
        <code>{children}</code>
      </pre>
      <CopyButton
        text={children}
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        copiedHoverReset={false}
      />
    </div>
  )
}

function InfoCard({ children }: { children: ReactNode }) {
  return <div className="bg-card border border-border rounded-2xl p-4">{children}</div>
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

function HowItWorksItem({
  icon: Icon,
  title,
  subtitle,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle: string
  iconClassName?: string
}) {
  return (
    <div className="flex flex-col items-center gap-0">
      <div className="p-3 mb-2 rounded-xl bg-background border border-border">
        <Icon className={iconClassName || "h-8 w-8 text-muted-foreground"} />
      </div>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </div>
  )
}

function HowItWorksConnector() {
  return <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
}

function Step({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
          <div className="flex-shrink-0 flex items-center justify-center font-medium text-logo">{number}.</div>
          <h3 className="font-medium text-foreground mb-2">{title}</h3>
        </div>
        <div className="text-muted-foreground text-sm space-y-3">{children}</div>
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

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
      {isConnected ? (
        <div className={cn(revealChildren && "transition-opacity duration-200 ease-snappy starting:opacity-0")}>
          {children}
        </div>
      ) : !needsSetup ? (
        // A transient state, so it stays quiet: no page chrome, one line.
        // Hidden through the reveal delay so fast connections never show it.
        <div
          role="status"
          className="flex flex-1 flex-col items-center justify-center gap-3 px-6 transition-opacity duration-200 ease-snappy starting:opacity-0"
          style={{ transitionDelay: `${CONNECTING_REVEAL_DELAY_MS}ms` }}
        >
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Connecting to {APP_NAME}…</p>
        </div>
      ) : (
        <div className="transition-opacity duration-200 ease-snappy starting:opacity-0">
          <PageHeader
            narrow
            icon={CodeXml}
            title={`Connect ${APP_NAME}`}
            subtitle={`Run ${APP_NAME} directly on your machine with full access to your local files and agent project history.`}
          />
          <div className="max-w-2xl w-full mx-auto pb-12 px-6">
            <div className="mb-8">
              <SettingsGroupHeading>Status</SettingsGroupHeading>
              <InfoCard>
                {/* Worded for the whole retry loop, so it doesn't change
                    between attempts; the spinner is the retrying. */}
                <div role="status" className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 shrink-0 text-muted-foreground animate-spin" />
                  <span className="text-sm text-muted-foreground">
                    Waiting for {APP_NAME}. Run <code className="bg-background border border-border rounded-md mx-0.5 p-1 font-mono text-xs text-foreground">{getCliInvocation()}</code> from any terminal on this machine.
                  </span>
                </div>
              </InfoCard>
            </div>

            <div className="mb-10">
              <SettingsGroupHeading>How it works</SettingsGroupHeading>
              <InfoCard>
                <div className="flex items-center justify-around gap-6 py-4 px-2">
                  <HowItWorksItem icon={Terminal} title={`${APP_NAME} CLI`} subtitle="On Your Machine" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={Monitor} title={`${APP_NAME} Server`} subtitle="Local WebSocket" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={CodeXml} title={`${APP_NAME} UI`} subtitle="Project Chat" />
                </div>
              </InfoCard>
            </div>

            <div className="mb-10">
              <SettingsGroupHeading>Setup</SettingsGroupHeading>
              <InfoCard>
                <div className="space-y-4">
                  <Step number={1} title={`Start ${APP_NAME}`}>
                    <p>Run this command in your terminal:</p>
                    <CodeBlock>{getCliInvocation()}</CodeBlock>
                  </Step>

                  <Step number={2} title="Open the local UI">
                    <p>{APP_NAME} serves the app locally and opens the Local Projects page in an app-style browser window.</p>
                    <CodeBlock>http://localhost:3210/local</CodeBlock>
                  </Step>

                  <div className="mt-8">
                    <h3 className="text-sm text-muted-foreground mb-3">Notes</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("").trim()}</code>
                        <span className="text-muted-foreground">Start in the current directory</span>
                      </div>
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("--no-open")}</code>
                        <span className="text-muted-foreground">Start the server without opening the browser</span>
                      </div>
                    </div>
                  </div>
                </div>
              </InfoCard>
            </div>
          </div>
        </div>
      )}

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
