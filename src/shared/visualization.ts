export const VISUALIZATION_TOOL_NAME = "show_visualization"
export const VISUALIZATION_MAX_BYTES = 2 * 1024 * 1024
export const VISUALIZATION_MAX_HEIGHT = 2400

/**
 * The expand button the web client lays over an inline visualization's
 * top-right corner, in CSS px. `clear` is the square of that corner authored
 * content keeps free: the inset, the button, and a margin. The tool
 * description quotes it, so the button and the prompt cannot drift apart.
 */
export const VISUALIZATION_EXPAND_BUTTON = { size: 28, inset: 8, clear: 48 } as const

export interface VisualizationArtifact {
  type: "visualization"
  version: 1
  url: string
  title: string
  height: number
}

// Only our immutable media files (or their exported copies) can become executable content.
export function isVisualizationUrl(value: string): boolean {
  return /^\/api\/chats\/[a-zA-Z0-9_-]+\/media\/visualization-[a-zA-Z0-9_-]+\.html$/.test(value)
    || /^\.\/attachments\/visualization-[a-zA-Z0-9_-]+\.html$/.test(value)
}

export function readVisualizationArtifact(value: unknown): VisualizationArtifact | null {
  if (!Array.isArray(value)) return null
  const artifact = value.find(item => item?.type === "visualization")
  if (!artifact || artifact.version !== 1 || typeof artifact.title !== "string"
    || typeof artifact.url !== "string" || !isVisualizationUrl(artifact.url)
    || typeof artifact.height !== "number" || !Number.isFinite(artifact.height)) return null
  return { ...artifact, height: Math.max(80, Math.min(VISUALIZATION_MAX_HEIGHT, artifact.height)) }
}

export function visualizationHeight(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.max(40, Math.min(VISUALIZATION_MAX_HEIGHT, Math.ceil(value))) : null
}

export function visualizationLink(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export interface VisualizationDownload {
  filename: string
  content: string
  mimeType: "text/csv" | "application/json" | "text/plain"
}

export function visualizationDownload(value: unknown): VisualizationDownload | null {
  if (!value || typeof value !== "object") return null
  const input = value as Record<string, unknown>
  const extensions: Record<string, string> = { "text/csv": ".csv", "application/json": ".json", "text/plain": ".txt" }
  if (typeof input.mimeType !== "string" || !Object.hasOwn(extensions, input.mimeType)
    || typeof input.content !== "string" || new TextEncoder().encode(input.content).length > VISUALIZATION_MAX_BYTES) return null
  let filename = typeof input.filename === "string" ? input.filename.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 100) : "data"
  if (!filename) filename = "data"
  if (!filename.endsWith(extensions[input.mimeType]!)) filename += extensions[input.mimeType]
  return { filename, content: input.content, mimeType: input.mimeType as VisualizationDownload["mimeType"] }
}
