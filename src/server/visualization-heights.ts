import { readFile, rename, stat, writeFile } from "node:fs/promises"
import { readVisualizationHeights, withVisualizationHeight, type VisualizationHeights } from "../shared/visualization"
import type { EventStore } from "./event-store"

/**
 * The heights clients have measured a saved visualization at, kept in a file
 * beside its document (see `VisualizationHeights`). Beside it so they go
 * where the document goes: copied with a fork, removed with the chat.
 *
 * Over HTTP, not the socket, like the document they describe: the frame that
 * measures is a leaf of the transcript and holds no socket, and the export
 * viewer, which shows the same frame, has no server at all. And not on the
 * document's own response, which a browser caches for a year.
 */
const ROUTE = /^(\/api\/chats\/[a-zA-Z0-9_-]+\/media\/visualization-[a-zA-Z0-9_-]+\.html)\/heights$/

function heightsPath(documentPath: string) {
  return `${documentPath}.heights.json`
}

export async function readStoredVisualizationHeights(documentPath: string): Promise<VisualizationHeights> {
  try {
    return readVisualizationHeights(JSON.parse(await readFile(heightsPath(documentPath), "utf8")))
  } catch {
    // None measured yet, or a file cut short: nothing known, which is where every document starts.
    return []
  }
}

export async function storeVisualizationHeight(documentPath: string, width: number, height: number): Promise<VisualizationHeights> {
  const heights = withVisualizationHeight(await readStoredVisualizationHeights(documentPath), width, height)
  // Whole or not at all: two tabs can report at once, and a reader must never see half a file.
  const temporary = `${heightsPath(documentPath)}.${crypto.randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(heights))
  await rename(temporary, heightsPath(documentPath))
  return heights
}

export async function handleVisualizationHeights(req: Request, url: URL, store: Pick<EventStore, "resolveTranscriptMediaPath">) {
  const match = url.pathname.match(ROUTE)
  if (!match) return null
  if (req.method !== "GET" && req.method !== "PUT") return new Response(null, { status: 405, headers: { Allow: "GET, PUT" } })

  const documentPath = store.resolveTranscriptMediaPath(match[1]!)
  const exists = documentPath ? await stat(documentPath).then((info) => info.isFile(), () => false) : false
  if (!documentPath || !exists) return Response.json({ error: "Visualization not found" }, { status: 404 })

  const headers = { "Cache-Control": "no-store" }
  if (req.method === "GET") return Response.json({ heights: await readStoredVisualizationHeights(documentPath) }, { headers })

  const body = await req.json().catch(() => null) as { width?: unknown; height?: unknown } | null
  const [measured] = readVisualizationHeights([[body?.width, body?.height]])
  if (!measured) return Response.json({ error: "Expected a width and a height" }, { status: 400 })
  return Response.json({ heights: await storeVisualizationHeight(documentPath, measured[0], measured[1]) }, { headers })
}
