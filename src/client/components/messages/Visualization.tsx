import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Maximize2, Shapes } from "lucide-react"
import { hasOpenLayer, resolveEscapePress } from "../../lib/escape-key"
import { fetchVisualizationHeights, pickVisualizationHeight, recordVisualizationHeight, rememberedVisualizationHeights, rememberVisualizationHeights } from "../../lib/visualization-heights"
import { openViewer } from "../../stores/viewerStore"
import { ViewerSurface } from "../viewer/ViewerSurface"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { type VisualizationArtifact, VISUALIZATION_EXPAND_BUTTON, visualizationHeight, visualizationLink, visualizationDownload, visualizationWidthBucket } from "../../../shared/visualization"
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

/** A page is still for this long before its height is taken as the one it settled at. */
const SETTLE_MS = 400
/** After this long loaded, a change of height is the reader's doing (a row opened, a toggle), not the page's. */
const SETTLED_FOR_GOOD_MS = 5000

/**
 * The saved document in its sandboxed frame, as tall as its content. Inline
 * and at full size are the same frame, same sandbox, same document; only
 * what is around it differs.
 *
 * The frame starts at the height the page last measured at this width, in
 * this browser or another (`lib/visualization-heights`), and holds that box
 * while the document loads, so nothing under it moves when the page comes
 * in. With none measured it starts at the height the agent declared.
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
  const [failed, setFailed] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number>()
  const [measured, setMeasured] = useState<number>()
  const [known, setKnown] = useState(() => rememberedVisualizationHeights(artifact.url))
  // What the message handler below reads: it is set up once, for the frame's life.
  const live = useRef({ url: artifact.url, declared: artifact.height, width, measured, known, loadedAt: 0, recordedBucket: 0 })
  Object.assign(live.current, { url: artifact.url, declared: artifact.height, width, measured, known })
  const settleTimer = useRef<number | undefined>(undefined)
  const knownFor = useRef(artifact.url)
  const height = measured ?? (width === undefined ? null : pickVisualizationHeight(known, width)) ?? artifact.height

  // Before first paint, so the box is the right height from the start.
  useLayoutEffect(() => {
    const element = box.current
    if (!element) return
    setWidth(element.clientWidth)
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(entry.contentRect.width) })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // Another browser may have measured this width. Asked once, and only when this one has not.
  const widthKnown = width !== undefined
  useEffect(() => {
    const { width, known } = live.current
    if (width === undefined || known.some(([measuredWidth]) => measuredWidth === visualizationWidthBucket(width))) return
    const controller = new AbortController()
    void fetchVisualizationHeights(artifact.url, controller.signal).then((fromServer) => {
      if (controller.signal.aborted || fromServer.length === 0) return
      // What this browser measured itself stands; the server fills in the other widths.
      const own = new Set(live.current.known.map(([measuredWidth]) => measuredWidth))
      const merged = [...live.current.known, ...fromServer.filter(([measuredWidth]) => !own.has(measuredWidth))].sort((left, right) => left[0] - right[0])
      rememberVisualizationHeights(artifact.url, merged)
      setKnown(merged)
    })
    return () => controller.abort()
  }, [artifact.url, widthKnown])

  useEffect(() => () => window.clearTimeout(settleTimer.current), [])

  useEffect(() => {
    const controller = new AbortController()
    setDocument(undefined)
    setFailed(false)
    setMeasured(undefined)
    // Another document in the same frame (its callers key by URL, so not today) starts from its own heights.
    if (knownFor.current !== artifact.url) setKnown(rememberedVisualizationHeights(artifact.url))
    knownFor.current = artifact.url
    Object.assign(live.current, { loadedAt: 0, recordedBucket: 0 })
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
        const state = live.current
        // The shell opens by reporting the declared height, before the page
        // has measured anything. Taken as a measurement, it would move a
        // frame that started at its real height away from it and back.
        const opening = next === state.declared && state.measured === undefined
          && state.width !== undefined && pickVisualizationHeight(state.known, state.width) !== null
        if (next === null || opening) return
        setMeasured(next)
        window.clearTimeout(settleTimer.current)
        settleTimer.current = window.setTimeout(() => {
          const { width, loadedAt, recordedBucket, url, known } = live.current
          if (width === undefined || loadedAt === 0) return
          const bucket = visualizationWidthBucket(width)
          if (recordedBucket === bucket && performance.now() - loadedAt > SETTLED_FOR_GOOD_MS) return
          live.current.recordedBucket = bucket
          const recorded = recordVisualizationHeight(url, known, width, next)
          if (recorded !== known) setKnown(recorded)
        }, SETTLE_MS)
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
  return (
    <div ref={box} className="min-w-0" style={{ height }}>
      {document ? (
        <iframe
          ref={frame}
          title={artifact.title}
          srcDoc={document}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="block size-full min-w-0 border-0 bg-transparent"
          style={{ colorScheme: visualizationTheme().appearance }}
          onLoad={() => {
            live.current.loadedAt = performance.now()
            frame.current?.contentWindow?.postMessage({ type: "kanna:theme", theme: visualizationTheme() }, "*")
            onLoaded?.()
          }}
        />
      ) : <p className="text-sm text-muted-foreground">Loading visualization...</p>}
    </div>
  )
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
