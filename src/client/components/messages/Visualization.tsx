import { useEffect, useRef, useState } from "react"
import { type VisualizationArtifact, visualizationHeight, visualizationLink, visualizationDownload } from "../../../shared/visualization"
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

export function Visualization({ artifact }: { artifact: VisualizationArtifact }) {
  const frame = useRef<HTMLIFrameElement>(null)
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
    onLoad={() => frame.current?.contentWindow?.postMessage({ type: "kanna:theme", theme: visualizationTheme() }, "*")}
  />
}
