import {
  pickVisualizationHeight,
  readVisualizationHeights,
  visualizationHeightsUrl,
  visualizationWidthBucket,
  withVisualizationHeight,
  type VisualizationHeights,
} from "../../shared/visualization"

/**
 * The heights this browser has measured visualizations at, so a frame is
 * the right height from its first paint on a reload, with no request to
 * wait for. The server keeps the same pairs for every other browser
 * (`server/visualization-heights.ts`); it is asked only for a width this
 * one has not measured.
 */
const STORAGE_KEY = "kanna-visualization-heights"
const DOCUMENTS_KEPT = 200

type Remembered = Record<string, VisualizationHeights>

function readAll(): Remembered {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Remembered : {}
  } catch {
    // No storage (private mode, the export viewer's file: page) is no memory, not a failure.
    return {}
  }
}

export function rememberedVisualizationHeights(url: string): VisualizationHeights {
  return readVisualizationHeights(readAll()[url])
}

export function rememberVisualizationHeights(url: string, heights: VisualizationHeights) {
  if (heights.length === 0) return
  try {
    const { [url]: _, ...others } = readAll()
    // Insertion order is age. This one goes to the end, the oldest fall off the front.
    const kept = Object.entries(others).slice(-(DOCUMENTS_KEPT - 1))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...kept, [url, heights]])))
  } catch {}
}

/** What the server has for this document: what other browsers measured. Empty when it cannot say. */
export async function fetchVisualizationHeights(url: string, signal?: AbortSignal): Promise<VisualizationHeights> {
  const endpoint = visualizationHeightsUrl(url)
  if (!endpoint) return []
  try {
    const response = await fetch(endpoint, { signal })
    return response.ok ? readVisualizationHeights((await response.json() as { heights?: unknown }).heights) : []
  } catch {
    return []
  }
}

/**
 * A frame's settled height at a width, kept here and sent to the server.
 * Returns what is now known for the document. Nothing is sent when it is
 * what was already known.
 */
export function recordVisualizationHeight(url: string, known: VisualizationHeights, width: number, height: number): VisualizationHeights {
  const bucket = visualizationWidthBucket(width)
  const next = withVisualizationHeight(known, width, height)
  const before = known.find(([measured]) => measured === bucket)?.[1]
  const after = next.find(([measured]) => measured === bucket)?.[1]
  if (after === undefined || before === after) return known
  rememberVisualizationHeights(url, next)
  const endpoint = visualizationHeightsUrl(url)
  if (endpoint) {
    void fetch(endpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ width: bucket, height: after }) }).catch(() => {})
  }
  return next
}

export { pickVisualizationHeight }
