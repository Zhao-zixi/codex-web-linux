import { Loader2, X } from "lucide-react"
import { MetaRow, MetaContent } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"

const STATUS_LABELS: Record<string, string> = {
  connecting: "Connecting...",
  acquiring_sandbox: "Booting...",
  initializing: "Initializing...",
  starting: "Starting...",
  running: "Running...",
  waiting_for_user: "Waiting...",
  waiting_on_subagent: "Waiting on a subagent...",
  failed: "Failed",
}

interface ProcessingMessageProps {
  status?: string
}

export function ProcessingMessage({ status }: ProcessingMessageProps) {
  const label = (status ? STATUS_LABELS[status] : undefined) || "Processing..."
  const isFailed = status === "failed"

  return (
    <MetaRow className="ml-[1px] mt-3">
      <MetaContent>
        {isFailed ? (
          <X className="size-4.5 text-red-500" />
        ) : (
          <Loader2 className="size-4.5 animate-spin text-muted-icon" />
        )}
        <AnimatedShinyText className="ml-[1px] text-sm" shimmerWidth={44}>
          {label}
        </AnimatedShinyText>
      </MetaContent>
    </MetaRow>
  )
}
