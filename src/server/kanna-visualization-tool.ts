import { z } from "zod"
import { constants } from "node:fs"
import { mkdir, open, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { VISUALIZATION_MAX_BYTES, VISUALIZATION_MAX_HEIGHT, VISUALIZATION_TOOL_NAME, type VisualizationArtifact } from "../shared/visualization"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { buildVisualizationDocument } from "./visualization-document"
import { SHOW_VISUALIZATION_DESCRIPTION } from "./visualization-instructions"
import type { KannaToolDefinition } from "./kanna-tools"

const schema = z.strictObject({
  title: z.string().min(1).max(200).describe("Accessible name for the visualization. No title bar is added."),
  html: z.string().min(1).max(VISUALIZATION_MAX_BYTES).optional().describe("Self-contained HTML fragment, including inline CSS and JavaScript. Supply html or path, not both."),
  path: z.string().min(1).optional().describe("HTML file, absolute or relative to the project. Copied into this chat; source edits will not change the saved visualization."),
  height: z.number().int().min(80).max(VISUALIZATION_MAX_HEIGHT).optional().describe("Initial height in CSS pixels, default 360. The frame then fits the content automatically."),
})

/**
 * The first thing in a document that the frame's CSP will refuse to load. A
 * page built on a CDN chart library renders as an empty box, and the model
 * that wrote it is told it succeeded; refused here, the error says what to do
 * while the model can still do it.
 */
export function externalResource(html: string): string | null {
  const script = /<script\b[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(html)
  if (script) return `a script from ${script[1]}`
  const sheet = /<link\b[^>]*\shref\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html) ?? /@import\s+(?:url\()?["']?(https?:[^"')\s;]+)/i.exec(html)
  if (sheet) return `a stylesheet from ${sheet[1]}`
  const image = /<img\b[^>]*\ssrc\s*=\s*["']?(https?:[^"'\s>]+)/i.exec(html)
  return image ? `an image from ${image[1]}` : null
}

export const SHOW_VISUALIZATION_TOOL: KannaToolDefinition = {
  name: VISUALIZATION_TOOL_NAME,
  description: SHOW_VISUALIZATION_DESCRIPTION,
  schema,
  async execute(input, context) {
    const args = schema.parse(input)
    if (Boolean(args.html) === Boolean(args.path)) throw new Error("Provide exactly one of html or path.")
    if (!context.dataDir) throw new Error("Chat media storage is unavailable.")
    context.signal.throwIfAborted()
    let html = args.html
    if (args.path) {
      const file = await open(path.resolve(context.cwd, args.path), constants.O_RDONLY | constants.O_NONBLOCK)
      try {
        const info = await file.stat()
        if (!info.isFile()) throw new Error("The visualization path must be a file.")
        if (info.size > VISUALIZATION_MAX_BYTES) throw new Error("Visualizations must be 2 MB or smaller.")
        html = await file.readFile("utf8")
      } finally { await file.close() }
    }
    if (!html?.trim()) throw new Error("The visualization HTML is empty.")
    if (Buffer.byteLength(html) > VISUALIZATION_MAX_BYTES) throw new Error("Visualizations must be 2 MB or smaller.")
    const external = externalResource(html)
    if (external) throw new Error(`The visualization loads ${external}, and nothing external loads in the frame. Inline the script, style, font or image (a data: URI works for images and fonts) and call the tool again.`)
    const height = args.height ?? 360
    const name = `visualization-${crypto.randomUUID()}.html`
    const dir = getTranscriptMediaDir(context.dataDir, context.chatId)
    await mkdir(dir, { recursive: true })
    const destination = path.join(dir, name)
    try {
      await writeFile(destination, buildVisualizationDocument(html, args.title, height), { flag: "wx" })
      context.signal.throwIfAborted()
    } catch (error) {
      await rm(destination, { force: true })
      throw error
    }
    const artifact: VisualizationArtifact = { type: "visualization", version: 1, title: args.title, height, url: buildTranscriptMediaUrl(context.chatId, name) }
    return {
      content: [{ type: "text", text: "Visualization displayed inline in Kanna. Do not repeat it as an image, file attachment, or visualization marker." }],
      structuredContent: { displayed: true, visualization: artifact },
      transcriptContent: [artifact],
    }
  },
}
