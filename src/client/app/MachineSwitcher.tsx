import { useEffect, useRef, useState, type ReactNode } from "react"
import { ChevronDown, Cloud, ExternalLink, LaptopMinimal } from "lucide-react"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog"
import { CloudPairPanel } from "../components/cloud/CloudPairPanel"
import { useCloudPairSession } from "../components/cloud/useCloudPairSession"
import { InputPopover, PopoverMenuItem } from "../components/chat-ui/ChatPreferenceControls"
import { findCurrentMachine, useConnectionStore } from "../stores/connectionStore"
import { displayClaimUrl } from "../lib/pairSession"
import { postToMacApp } from "../lib/macApp"
import { cn } from "../lib/utils"
import type { CloudMachineSummary } from "../../shared/cloud-api"

const MANAGE_MACHINES_URL = "https://kanna.sh/machines"
const THIS_MAC_NAME = "This Mac"

/** Shared trigger padding: borderless, but keeps the same net inset as before. */
const TRIGGER_CLASS = "w-full justify-between py-1.5 rounded-md hover:bg-transparent"

const SIDEBAR_BUTTON_CLASS = cn(
  "flex items-center gap-1.5 px-[10px] text-sm text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
  TRIGGER_CLASS
)

/** Wrapper for the sidebar footer: sits just above the Settings button. */
function MachineSection({ children }: { children: ReactNode }) {
  return <div className="pl-2.5 pr-[7px] py-1 border-t ">{children}</div>
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"}`}
      aria-hidden
    />
  )
}

/**
 * Sidebar machine switcher. Cloud mode lists the account's machines and
 * navigates between their subdomains (mode comes from connectionStore's
 * /__cloud/machines feature detection); local mode offers one-click pairing,
 * or a shortcut to the hosted URL once this machine has one. In Kanna for
 * Mac, signed in, it's always the machine list, and the app does the
 * switching (this Mac at localhost, the rest at kanna.sh).
 */
export function MachineSwitcher() {
  const mode = useConnectionStore((state) => state.mode)
  const machines = useConnectionStore((state) => state.machines)
  const load = useConnectionStore((state) => state.load)
  const fromMacApp = useConnectionStore((state) => state.fromMacApp)
  const thisMachineSubdomain = useConnectionStore((state) => state.thisMachine)
  const showingMachine = useConnectionStore((state) => state.showingMachine)
  const [pairDialogOpen, setPairDialogOpen] = useState(false)
  const { session, starting, begin } = useCloudPairSession({ enabled: mode === "local" })
  const startedRef = useRef(false)

  useEffect(() => {
    if (mode === "unknown") {
      void load()
    }
  }, [mode, load])

  // Mint a claim URL the first time the dialog opens; the server reuses a
  // live session, so reopening never burns a code.
  useEffect(() => {
    if (!pairDialogOpen || startedRef.current) return
    if (session.status === "paired" || session.status === "unsupported") return
    startedRef.current = true
    begin()
  }, [pairDialogOpen, session.status, begin])

  if (mode === "unknown") {
    return null
  }

  if (mode === "local") {
    const pairedOrigin = session.status === "paired" ? session.appOrigin : null
    return (
      <MachineSection>
        {pairedOrigin ? (
          <a href={pairedOrigin} target="_blank" rel="noreferrer" className={SIDEBAR_BUTTON_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              <Cloud className="ml-[1px] size-4 shrink-0" />
              <span className="truncate text-xs font-medium">{displayClaimUrl(pairedOrigin)}</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : (
          <button type="button" onClick={() => setPairDialogOpen(true)} className={SIDEBAR_BUTTON_CLASS}>
            <span className="flex min-w-0 items-center gap-2">
              <Cloud className="ml-[1px] size-4 shrink-0" />
              <span className="truncate text-xs font-medium">Setup Kanna Cloud</span>
            </span>
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </button>
        )}
        <Dialog open={pairDialogOpen} onOpenChange={setPairDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Use this machine from anywhere</DialogTitle>
              <DialogDescription>
                Get a personal URL that works from any browser, 100% free.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <CloudPairPanel session={session} starting={starting} onRetry={begin} />
            </DialogBody>
          </DialogContent>
        </Dialog>
      </MachineSection>
    )
  }

  // In Kanna for Mac the app says which machine is showing and which is this
  // Mac (at localhost, where the hostname names no machine). This Mac is
  // listed first, even when it isn't on Kanna Cloud, so there's a way back.
  const thisMachine = fromMacApp ? machines.find((machine) => machine.subdomain === thisMachineSubdomain) : undefined
  const currentMachine = fromMacApp
    ? machines.find((machine) => machine.subdomain === (showingMachine ?? thisMachineSubdomain)) ?? null
    : findCurrentMachine(machines)
  const showingThisMac = fromMacApp && (showingMachine === null || showingMachine === thisMachineSubdomain)
  const otherMachines = fromMacApp
    ? machines.filter((machine) => machine.subdomain !== thisMachineSubdomain)
    : machines
  const open = (machine: CloudMachineSummary | null) => {
    if (fromMacApp) {
      postToMacApp({ type: "openMachine", subdomain: machine?.subdomain ?? null })
    } else if (machine) {
      window.location.href = machine.appOrigin
    }
  }

  return (
    <MachineSection>
      <InputPopover
        triggerClassName={cn(TRIGGER_CLASS, "px-[11px]")}
        trigger={
          <>
            <span className="flex min-w-0 items-center gap-2">
              <LaptopMinimal className="size-4 shrink-0" />
              <span className="truncate text-xs font-medium">
                {currentMachine?.name ?? (showingThisMac ? THIS_MAC_NAME : window.location.hostname)}
              </span>
            </span>
            <ChevronDown className="size-3.5 shrink-0 opacity-60" />
          </>
        }
      >
        {(close) => (
          <>
            {fromMacApp ? (
              <PopoverMenuItem
                onClick={() => {
                  close()
                  if (!showingThisMac) open(null)
                }}
                selected={showingThisMac}
                icon={<OnlineDot online />}
                label={
                  <>
                    {thisMachine?.name ?? THIS_MAC_NAME}{" "}
                    <span className="text-muted-foreground">(This machine)</span>
                  </>
                }
                description={thisMachine ? `${thisMachine.subdomain}.kanna.sh` : "Not on Kanna Cloud"}
              />
            ) : null}
            {otherMachines.map((machine) => {
              const isCurrent = machine.subdomain === currentMachine?.subdomain
              return (
                <PopoverMenuItem
                  key={machine.subdomain}
                  onClick={() => {
                    close()
                    if (!isCurrent) open(machine)
                  }}
                  selected={isCurrent}
                  icon={<OnlineDot online={machine.online} />}
                  label={machine.name}
                  description={`${machine.subdomain}.kanna.sh${machine.online ? "" : " · offline"}`}
                />
              )
            })}
            <PopoverMenuItem
              onClick={() => {
                close()
                window.open(MANAGE_MACHINES_URL, "_blank", "noopener")
              }}
              selected={false}
              icon={<ExternalLink className="h-4 w-4" />}
              label="Manage machines"
              description="Add or remove machines on kanna.sh"
            />
          </>
        )}
      </InputPopover>
    </MachineSection>
  )
}
