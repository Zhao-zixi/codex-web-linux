import { useEffect, useRef, useState } from "react"
import { Maximize2, Shapes } from "lucide-react"
import { hasOpenLayer, resolveEscapePress } from "../../lib/escape-key"
import { openViewer } from "../../stores/viewerStore"
import { ViewerSurface } from "../viewer/ViewerSurface"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { type VisualizationArtifact, VISUALIZATION_EXPAND_BUTTON, visualizationHeight, visualizationLink, visualizationDownload } from "../../../shared/visualization"
import { prepareVisualizationDocument, type VisualizationTheme } from "../../../shared/visualization-host"

/** Read actual host tokens, rather than deriving dark mode from the OS. This also
 * covers custom transcript backgrounds and theme changes while a widget is live. */
export function visualizationTheme(): VisualizationTheme {
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const variables: Record<string, string> = {}
  variables["--font-sans"] = getComputedStyle(document.body).fontFamily
  for (const name of ["background", "foreground", "muted", "muted-foreground", "border"]) {
    const value = styles.getPropertyValue(`--${name}`).trim()
    if (value) variables[`--${name}`] = `hsl(${value})`
  }
  const surface = styles.getPropertyValue("--popover").trim()
  if (surface) variables["--surface"] = `hsl(${surface})`
  for (const name of ["red", "green", "blue", "yellow", "orange", "purple", "pink", "teal"]) {
    const value = styles.getPropertyValue(`--viz-${name}`).trim()
    if (value) variables[`--viz-${name}`] = value
  }
  return { appearance: root.classList.contains("dark") ? "dark" : "light", variables }
}

/**
 * The saved document in its sandboxed frame, as tall as its content. Inline
 * and at full size are the same frame, same sandbox, same document; only
 * what is around it differs.
 */
function VisualizationFrame({ artifact, onLoaded, onEscape }: {
  artifact: VisualizationArtifact
  onLoaded?: () => void
  /** Escape was pressed in the frame and the visualization had no use for it. */
  onEscape?: (repeat: boolean) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  const [document, setDocument] = useState<string>()
  const [height, setHeight] = useState(artifact.height)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setDocument(undefined)
    setFailed(false)
    setHeight(artifact.height)
    fetch(artifact.url, { signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error("Visualization unavailable")
      const [html, { visualizationFontCss }] = await Promise.all([response.text(), import("./visualization-fonts")])
      if (!controller.signal.aborted) setDocument(prepareVisualizationDocument(html, visualizationTheme(), visualizationFontCss))
    }).catch(() => { if (!controller.signal.aborted) setFailed(true) })
    return () => controller.abort()
  }, [artifact.url, artifact.height])

  useEffect(() => {
    const syncTheme = () => {
      if (!frame.current) return
      const theme = visualizationTheme()
      frame.current.style.colorScheme = theme.appearance
      frame.current.contentWindow?.postMessage({ type: "kanna:theme", theme }, "*")
    }
    const onMessage = (event: MessageEvent) => {
      if (!frame.current?.contentWindow || event.source !== frame.current.contentWindow) return
      if (event.data?.type === "kanna:ready") syncTheme()
      if (event.data?.type === "kanna:escape") onEscapeRef.current?.(event.data.repeat === true)
      if (event.data?.type === "kanna:resize") {
        const next = visualizationHeight(event.data.height)
        if (next !== null) setHeight(next)
      }
      if (event.data?.type === "kanna:download") {
        const download = visualizationDownload(event.data.download)
        if (download) {
          const url = URL.createObjectURL(new Blob([download.content], { type: download.mimeType }))
          const link = window.document.createElement("a")
          link.href = url
          link.download = download.filename
          link.click()
          setTimeout(() => URL.revokeObjectURL(url), 1000)
        }
      }
      if (event.data?.type === "kanna:link") {
        const url = visualizationLink(event.data.url)
        if (url) window.open(url, "_blank", "noopener,noreferrer")
      }
    }
    window.addEventListener("message", onMessage)
    const observer = new MutationObserver(syncTheme)
    observer.observe(window.document.documentElement, { attributes: true, attributeFilter: ["class", "style"] })
    syncTheme()
    return () => { window.removeEventListener("message", onMessage); observer.disconnect() }
  }, [])

  if (failed) return <p role="alert" className="text-sm text-muted-foreground">This visualization could not be loaded.</p>
  if (!document) return <p className="text-sm text-muted-foreground">Loading visualization...</p>
  return <iframe
    ref={frame}
    title={artifact.title}
    srcDoc={document}
    sandbox="allow-scripts"
    referrerPolicy="no-referrer"
    className="block w-full min-w-0 border-0 bg-transparent"
    style={{ height, colorScheme: visualizationTheme().appearance }}
    onLoad={() => {
      frame.current?.contentWindow?.postMessage({ type: "kanna:theme", theme: visualizationTheme() }, "*")
      onLoaded?.()
    }}
  />
}

/**
 * A visualization in the transcript: the frame, bare, as part of the reply,
 * with the way to full size over its top-right corner. The tool description
 * tells whoever writes one to keep that corner clear.
 */
export function Visualization({ artifact }: { artifact: VisualizationArtifact }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <div className="visualization relative min-w-0">
      <VisualizationFrame artifact={artifact} onLoaded={() => setLoaded(true)} />
      {loaded ? <VisualizationExpandButton onClick={() => openViewer({ kind: "visualization", artifact }, { expanded: true })} /> : null}
    </div>
  )
}

/**
 * Opaque, so it reads over whatever the chart has drawn under it, in either
 * theme. The glyph is 14px, not the 16px of the viewer's square buttons: its
 * arrows point at the corners, which a circle does not have.
 */
export function VisualizationExpandButton({ onClick }: { onClick: () => void }) {
  const { size, inset } = VISUALIZATION_EXPAND_BUTTON
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label="Expand"
          onClick={onClick}
          style={{ top: inset, right: inset, width: size, height: size }}
          className="visualization-expand absolute flex items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs hover:bg-muted hover:text-foreground [&_svg]:size-3.5"
        >
          <Maximize2 />
        </button>
      </TooltipTrigger>
      <TooltipContent>Expand</TooltipContent>
    </Tooltip>
  )
}

/**
 * A visualization at full size in the viewer. A second copy of the document,
 * loaded fresh: a frame moved in the page loads again anyway, and the one in
 * the transcript is under a chat that goes inert while this is over it. So
 * what was set inline (a tab, a slider) starts over here, and what is set
 * here stays here.
 *
 * The frame keeps its content's height and the card scrolls, as inline. A
 * frame stretched to the card would tell the content nothing: it is written
 * to its own height, not the viewport's.
 */
export function VisualizationFullView({ artifact, onClose }: { artifact: VisualizationArtifact; onClose: () => void }) {
  return (
    <ViewerSurface label={`Visualization: ${artifact.title}`} icon={<Shapes />} title={artifact.title} onClose={onClose}>
      <div className="p-4">
        <VisualizationFrame
          artifact={artifact}
          // A key pressed in the frame is the frame's, and the card never
          // hears it. The frame hands Escape back when it has no use for it.
          onEscape={(repeat) => {
            const action = resolveEscapePress({ repeat, claimed: hasOpenLayer(), paneOpen: true, canInterrupt: false })
            if (action === "close-pane") onClose()
          }}
        />
      </div>
    </ViewerSurface>
  )
}
