import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import { ArrowUpRight, Check, ChevronLeft, Cloud, Flower, LaptopMinimal } from "lucide-react"
import { AUTH_SERVICE_LABELS, type AuthServiceId } from "../../../shared/types"
import { cn } from "../../lib/utils"
import { displayClaimUrl } from "../../lib/pairSession"
import { useProviderAuthStore, useSetupStatus, selectAuthService } from "../../stores/providerAuthStore"
import { CloudPairPanel } from "../cloud/CloudPairPanel"
import { useCloudPairSession } from "../cloud/useCloudPairSession"
import { AUTH_SERVICE_ICONS } from "../provider-icons"
import { Button } from "../ui/button"
import { AuthCard } from "./AuthCard"
import { Done, MacSetupCards, SetupList, SetupRow, macSetupAvailable, macSetupSatisfied, useMacSetupState } from "./MacSetupStep"

/**
 * The cloud step is dropped entirely when this machine can't use it (already
 * paired, or a run that can't pair in place), so the progress bar never
 * promises a step that won't appear. The This Mac step exists only in Kanna
 * for Mac (MacSetupStep), and comes first: Full Disk Access can make macOS
 * quit and reopen the app, better before anything else is under way.
 */
const BASE_STEPS = ["github", "agents", "openrouter"] as const
type SetupStep = "mac" | (typeof BASE_STEPS)[number] | "cloud" | "done"

/** Auto-advance delay after a skippable step connects — long enough to see the ✓ land. */
const AUTO_ADVANCE_MS = 900

const AGENT_SERVICES: AuthServiceId[] = ["claude", "codex", "cursor"]

/** A title and, at most, one short line. The card under it says the rest. */
function StepHeading({ title, description }: { title: string; description?: string }) {
  return (
    <div className="space-y-1.5 text-center">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {description ? <p className="mx-auto max-w-sm text-sm text-muted-foreground">{description}</p> : null}
    </div>
  )
}

/**
 * Shared step footer:
 *   [ (‹)  |        Continue        ]
 *              Skip for now
 * Back is a circular icon button inline with Continue; Skip sits below.
 *
 * A step whose own action happens elsewhere (Kanna Cloud's sign-in link)
 * passes `link`: until the step is done, that link takes Continue's place,
 * so the step never shows a dead Continue next to the thing to do.
 */
const FOOTER_PRESS = "transition-[scale,background-color,color,border-color] duration-150 ease-snappy active:scale-[0.97]"
/** Back, Continue and the link that stands in for it: one height, so the row reads as one control. */
const FOOTER_HEIGHT = "h-11 min-h-11"

function StepFooter({
  canContinue,
  onContinue,
  onBack,
  onSkip,
  hint,
  link,
}: {
  canContinue: boolean
  onContinue: () => void
  onBack?: () => void
  onSkip?: () => void
  hint?: string
  link?: { href: string; label: string }
}) {
  return (
    <div className="mt-auto space-y-2 pt-10">
      <div className="flex items-center gap-2">
        {/* Back (or an equal spacer) plus a mirrored spacer on the right keep
            Continue the same width and dead-center on every step. */}
        {onBack ? (
          <Button
            variant="outline"
            aria-label="Back"
            onClick={onBack}
            className={cn(FOOTER_HEIGHT, "w-11 shrink-0 rounded-full p-0", FOOTER_PRESS)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        ) : (
          <div aria-hidden className={cn(FOOTER_HEIGHT, "w-11 shrink-0")} />
        )}
        {link && !canContinue ? (
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className={cn(
              FOOTER_HEIGHT,
              "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90",
              FOOTER_PRESS,
            )}
          >
            {link.label}
            <ArrowUpRight className="h-4 w-4" />
          </a>
        ) : (
          // Disabled reads as not-yet, not as a broken button: a quiet muted
          // fill instead of a half-transparent primary.
          <Button
            className={cn(
              FOOTER_HEIGHT,
              "flex-1 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100",
              FOOTER_PRESS,
            )}
            disabled={!canContinue}
            onClick={onContinue}
          >
            Continue
          </Button>
        )}
        <div aria-hidden className={cn(FOOTER_HEIGHT, "w-11 shrink-0")} />
      </div>
      {/* The skip slot always occupies its height so the row above never jumps. */}
      {onSkip ? (
        <Button
          variant="ghost"
          onClick={onSkip}
          className="mx-auto flex h-10 w-auto px-4 text-muted-foreground transition-colors duration-150 hover:bg-transparent dark:hover:bg-transparent hover:border-transparent hover:text-foreground"
        >
          Skip for now
        </Button>
      ) : (
        <div aria-hidden={hint ? undefined : true} className="flex h-10 items-center justify-center">
          {hint ? <p className="text-center text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      )}
    </div>
  )
}

/** A row of the final summary: done, or quietly skipped. */
function SummaryRow({ icon, title, done, pending = "Skipped" }: {
  icon: ReactNode
  title: string
  done: boolean
  pending?: string
}) {
  return (
    <SetupRow
      icon={icon}
      title={title}
      muted={!done}
      action={done ? <Done /> : <span className="pr-1 text-xs text-muted-foreground/70">{pending}</span>}
    />
  )
}

/**
 * Full-screen, distraction-free onboarding flow:
 *   0. This Mac (Kanna for Mac only) → 1. GitHub (skippable) → 2. at least one coding agent → 3. OpenRouter
 *   (skippable) → 4. Kanna Cloud (skippable, omitted when unavailable) →
 *   5. done. Reuses the AuthCard sign-in mechanics; steps that are already
 * satisfied are skipped on open, and skippable steps auto-advance the moment
 * they connect.
 */
// Takes no props, so memo bails unconditionally whenever the app shell
// re-renders - which is every streamed transcript entry. Its zustand
// subscriptions still drive it normally.
export const SetupWizard = memo(function SetupWizard() {
  const open = useProviderAuthStore((store) => store.setupWizardOpen)
  const socket = useProviderAuthStore((store) => store.socket)
  const snapshot = useProviderAuthStore((store) => store.snapshot)
  const dismissSetupWizard = useProviderAuthStore((store) => store.dismissSetupWizard)
  const completeSetupWizard = useProviderAuthStore((store) => store.completeSetupWizard)
  const status = useSetupStatus()
  const navigate = useNavigate()

  // Finishing onboarding always lands on the home page.
  const handleComplete = () => {
    completeSetupWizard()
    navigate("/")
  }

  const [step, setStep] = useState<SetupStep>("github")
  const wasOpenRef = useRef(false)

  // A property of the page (the app, this Mac's own server), not of the run.
  const [macStepEnabled] = useState(macSetupAvailable)
  // GitHub already connected (say, gh signed in before Kanna existed): no
  // step to show. Decided once gh's status is known, not on open: a first
  // launch opens before the provider checks finish, and "not checked yet"
  // isn't "not connected". Never pulled away from under the user, though.
  const [githubStepEnabled, setGithubStepEnabled] = useState(true)
  const githubDecidedRef = useRef(false)
  const ghStatus = selectAuthService(snapshot, "gh")?.authStatus
  const ghKnown = ghStatus !== undefined && ghStatus !== "unknown"
  const macState = useMacSetupState(open && macStepEnabled)

  // Kanna › Setup… in the Mac app opens this wizard; its Fleet menu's Put
  // This Mac Online… opens it at the Kanna Cloud step.
  const requestedStepRef = useRef<SetupStep | null>(null)
  useEffect(() => {
    window.__kannaOpenSetup = (requested?: string) => {
      requestedStepRef.current = requested === "cloud" ? "cloud" : null
      useProviderAuthStore.getState().openSetupWizard()
    }
    return () => {
      delete window.__kannaOpenSetup
    }
  }, [])

  const cloud = useCloudPairSession({ enabled: open })
  // Decided once per open, from the first status that lands: a machine that
  // pairs mid-wizard must not yank its own step out from under itself.
  const [cloudStepEnabled, setCloudStepEnabled] = useState(false)
  const cloudDecidedRef = useRef(false)
  const cloudStartedRef = useRef(false)

  useEffect(() => {
    if (!open) {
      cloudDecidedRef.current = false
      cloudStartedRef.current = false
      return
    }
    if (cloudDecidedRef.current || !cloud.loaded) return
    cloudDecidedRef.current = true
    const enabled = cloud.session.status !== "paired" && cloud.session.status !== "unsupported"
    setCloudStepEnabled(enabled)
    if (enabled && requestedStepRef.current === "cloud") setStep("cloud")
    requestedStepRef.current = null
  }, [open, cloud.loaded, cloud.session.status])

  const steps = useMemo<SetupStep[]>(
    () => [
      ...(macStepEnabled ? (["mac"] as const) : []),
      ...BASE_STEPS.filter((base) => base !== "github" || githubStepEnabled),
      ...(cloudStepEnabled ? (["cloud"] as const) : []),
      "done",
    ],
    [macStepEnabled, githubStepEnabled, cloudStepEnabled]
  )

  // Steps push sideways: forward, the step leaves to the left as the next
  // arrives from the right; back is the exact reverse. The leaving step stays
  // on screen, inert, for its short exit (index.css .wizard-leave). A second
  // press mid-transition replaces it, so nothing ever waits.
  type Direction = "open" | "forward" | "back" | "finish"
  const [leaving, setLeaving] = useState<{ from: SetupStep; direction: "forward" | "back"; id: number } | null>(null)
  const [enterDirection, setEnterDirection] = useState<Direction>("open")
  const go = (next: SetupStep) => {
    if (next === step) return
    const direction = steps.indexOf(next) >= steps.indexOf(step) ? "forward" : "back"
    setLeaving({ from: step, direction, id: Date.now() })
    setEnterDirection(next === "done" && direction === "forward" ? "finish" : direction)
    setStep(next)
  }

  // On open, start at the first unsatisfied step (all satisfied → done).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setLeaving(null)
      setEnterDirection("open")
      githubDecidedRef.current = ghKnown
      setGithubStepEnabled(!ghKnown || !status.githubConnected)
      setStep(
        macStepEnabled && !macSetupSatisfied(macState) ? "mac"
        : !status.githubConnected ? "github"
        : !status.anyAgentConnected ? "agents"
        : !status.openRouterConnected ? "openrouter"
        : "done"
      )
    }
    wasOpenRef.current = open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) {
      githubDecidedRef.current = false
      return
    }
    if (githubDecidedRef.current || !ghKnown) return
    githubDecidedRef.current = true
    if (status.githubConnected && step !== "github") setGithubStepEnabled(false)
  }, [open, ghKnown, status.githubConnected, step])

  // Entering the cloud step mints the claim URL (once — the server hands back
  // the live session if one is already open).
  const cloudStatus = cloud.session.status
  const beginCloudPairing = cloud.begin
  useEffect(() => {
    if (step !== "cloud" || cloudStartedRef.current || cloudStatus === "paired") return
    cloudStartedRef.current = true
    beginCloudPairing()
  }, [step, cloudStatus, beginCloudPairing])

  // Auto-advance skippable steps on the false→true connect transition only,
  // so navigating Back to an already-connected step doesn't bounce forward.
  const prevGithubRef = useRef(status.githubConnected)
  const prevOpenRouterRef = useRef(status.openRouterConnected)
  useEffect(() => {
    const githubJustConnected = !prevGithubRef.current && status.githubConnected
    const openRouterJustConnected = !prevOpenRouterRef.current && status.openRouterConnected
    prevGithubRef.current = status.githubConnected
    prevOpenRouterRef.current = status.openRouterConnected
    if (!open) return
    if (step === "github" && githubJustConnected) {
      const timer = setTimeout(() => go("agents"), AUTO_ADVANCE_MS)
      return () => clearTimeout(timer)
    }
    if (step === "openrouter" && openRouterJustConnected) {
      const timer = setTimeout(() => go(cloudStepEnabled ? "cloud" : "done"), AUTO_ADVANCE_MS)
      return () => clearTimeout(timer)
    }
  }, [open, step, status.githubConnected, status.openRouterConnected, cloudStepEnabled])

  // Same treatment for the cloud step: let the "you're live" state land, then
  // move on. The machine keeps connecting in the background either way.
  const machinePaired = cloud.session.status === "paired"
  const prevPairedRef = useRef(machinePaired)
  useEffect(() => {
    const justPaired = !prevPairedRef.current && machinePaired
    prevPairedRef.current = machinePaired
    if (!open || step !== "cloud" || !justPaired) return
    const timer = setTimeout(() => go("done"), AUTO_ADVANCE_MS * 2)
    return () => clearTimeout(timer)
  }, [open, step, machinePaired])

  const stepIndex = steps.indexOf(step)
  const progressPercent = ((stepIndex + 1) / steps.length) * 100

  const services = useMemo(() => ({
    gh: selectAuthService(snapshot, "gh"),
    agents: AGENT_SERVICES.map((id) => selectAuthService(snapshot, id)).filter(
      (service): service is NonNullable<typeof service> => service !== null
    ),
    openrouter: selectAuthService(snapshot, "openrouter"),
  }), [snapshot])

  if (!open || !socket) return null

  const goBack = () => go(steps[Math.max(0, stepIndex - 1)])
  const goNext = () => go(steps[Math.min(steps.length - 1, stepIndex + 1)])

  // Any step, for the one entering and the one leaving alike.
  const renderStep = (current: SetupStep) => (
    <>
          {current === "mac" ? (
            <>
              <StepHeading
                title="Set up this Mac"
                description="Keep your agents running while you're away."
              />
              <div className="mt-8">
                <MacSetupCards state={macState} />
              </div>
              <StepFooter canContinue onContinue={goNext} />
            </>
          ) : null}

          {current === "github" ? (
            <>
              <StepHeading
                title="Connect GitHub"
                description="Clone repos and open pull requests."
              />
              <SetupList className="mt-8">
                {services.gh ? <AuthCard row service={services.gh} socket={socket} /> : null}
              </SetupList>
              <StepFooter
                canContinue={status.githubConnected}
                onContinue={goNext}
                onBack={stepIndex > 0 ? goBack : undefined}
                onSkip={!status.githubConnected ? goNext : undefined}
              />
            </>
          ) : null}

          {current === "agents" ? (
            <>
              <StepHeading
                title="Connect your agents"
                description="At least one to start."
              />
              <SetupList className="mt-8">
                {services.agents.map((service) => (
                  <AuthCard row key={service.service} service={service} socket={socket} />
                ))}
              </SetupList>
              <StepFooter
                canContinue={status.anyAgentConnected}
                onContinue={goNext}
                onBack={stepIndex > 0 ? goBack : undefined}
              />
            </>
          ) : null}

          {current === "openrouter" ? (
            <>
              <StepHeading
                title="Connect OpenRouter"
                description="Powers Pi, chat names and commit messages."
              />
              <SetupList className="mt-8">
                {services.openrouter ? <AuthCard row service={services.openrouter} socket={socket} /> : null}
              </SetupList>
              <StepFooter
                canContinue={status.openRouterConnected}
                onContinue={goNext}
                onBack={goBack}
                onSkip={!status.openRouterConnected ? goNext : undefined}
              />
            </>
          ) : null}

          {current === "cloud" ? (
            <>
              <StepHeading
                title="Use this machine anywhere"
                description="A free URL for it, in any browser."
              />
              <div className="mt-8">
                <CloudPairPanel
                  session={cloud.session}
                  starting={cloud.starting}
                  onRetry={cloud.begin}
                  showOpenButton={false}
                />
              </div>
              <StepFooter
                canContinue={machinePaired}
                onContinue={goNext}
                onBack={goBack}
                onSkip={!machinePaired ? goNext : undefined}
                link={cloud.session.status === "waiting" && cloud.session.claimUrl
                  ? { href: cloud.session.claimUrl, label: "Open link & sign in" }
                  : undefined}
              />
            </>
          ) : null}

          {current === "done" ? (
            <>
              <div className="flex flex-col items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10">
                  <Check className="h-6 w-6 text-emerald-500" />
                </div>
                <StepHeading title="You're all set" />
              </div>
              <SetupList className="mt-8">
                {(["claude", "codex", "cursor", "gh", "openrouter"] as AuthServiceId[]).map((id) => {
                  const connected = selectAuthService(snapshot, id)?.authStatus === "signed_in"
                  const Icon = AUTH_SERVICE_ICONS[id]
                  return (
                    <SummaryRow
                      key={id}
                      icon={<Icon className="size-4" />}
                      title={AUTH_SERVICE_LABELS[id]}
                      done={connected}
                    />
                  )
                })}
                {macStepEnabled ? (
                  <SummaryRow
                    icon={<LaptopMinimal className="size-4" />}
                    title="This Mac"
                    done={macSetupSatisfied(macState)}
                    pending="Partly"
                  />
                ) : null}
                {cloudStepEnabled ? (
                  <SummaryRow
                    icon={<Cloud className="size-4" />}
                    title={machinePaired && cloud.session.appOrigin ? displayClaimUrl(cloud.session.appOrigin) : "Kanna Cloud"}
                    done={machinePaired}
                  />
                ) : null}
              </SetupList>
              <div className="mt-auto pt-10">
                <Button className={cn(FOOTER_HEIGHT, "w-full", FOOTER_PRESS)} onClick={handleComplete}>
                  Start Building
                </Button>
              </div>
            </>
          ) : null}
    </>
  )

  return (
    <div className="fixed inset-0 z-[70] overflow-y-auto overflow-x-hidden bg-background animate-in fade-in duration-300">
      {/* Low-emphasis escape hatch — suppresses auto-launch, keeps the Setup card. */}
      <button
        type="button"
        onClick={dismissSetupWizard}
        className="absolute right-4 top-4 z-10 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        Set up later
      </button>

      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-10 pt-14 sm:pt-20">
        {/* Logo + progress. On the last step the bar fills, then both lift
            away and the ending stands alone (index.css .wizard-header). */}
        <div className="wizard-header mb-10 flex flex-col items-center gap-5" data-finished={step === "done" || undefined}>
          <Flower className="h-7 w-7 text-logo" />
          <div className="h-1 w-44 overflow-hidden rounded-full bg-muted">
            {/* Slides inside the track rather than changing width, so the
                round end stays round through the overshoot. */}
            <div
              className="wizard-progress h-full w-full rounded-full bg-logo"
              style={{ transform: `translateX(${progressPercent - 100}%)` }}
            />
          </div>
        </div>

        <div className="relative flex flex-1 flex-col">
          {leaving ? (
            <div
              key={`leave-${leaving.id}`}
              inert
              aria-hidden
              data-direction={leaving.direction}
              className="wizard-leave pointer-events-none absolute inset-0 flex flex-col"
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) setLeaving(null)
              }}
            >
              {renderStep(leaving.from)}
            </div>
          ) : null}
          <div key={step} data-direction={enterDirection} className="wizard-step flex flex-1 flex-col">
            {renderStep(step)}
          </div>
        </div>
      </div>
    </div>
  )
})