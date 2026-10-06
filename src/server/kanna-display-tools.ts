import { z } from "zod"
import { mkdir, open, copyFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { type DisplayAttachment } from "../shared/display-tools"
import { SHOW_VISUALIZATION_TOOL } from "./kanna-visualization-tool"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import type { KannaToolDefinition } from "./kanna-tools"

const attachmentSchema = z.strictObject({
  attachments: z.array(z.strictObject({
    path: z.string().min(1).optional().describe("Local file path, absolute or relative to the project directory."),
    url: z.string().url().optional().describe("HTTP or HTTPS URL. Provide path or url, not both."),
    kind: z.enum(["image", "video", "file"]).optional().describe("For web URLs without a file extension, specify the media kind. Local files use their detected type."),
  })).min(1).max(24),
})

// SVG and HTML stay downloads. They must not run scripts on the app's origin.
export function attachmentKind(mime: string): DisplayAttachment["kind"] {
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime)) return "image"
  if (["video/mp4", "video/webm", "video/quicktime", "video/ogg"].includes(mime)) return "video"
  return "file"
}

/**
 * Copies a local file into the chat's media storage and describes it for the transcript.
 * Every tool that shows local files goes through here, so the files stay available
 * after the source changes and render through the same attachment card.
 */
export async function storeLocalAttachment(
  source: string,
  context: { chatId: string; dataDir?: string },
): Promise<{ attachment: DisplayAttachment; destination: string }> {
  if (!context.dataDir) throw new Error("Chat media storage is unavailable.")
  const handle = await open(source, constants.O_RDONLY | constants.O_NONBLOCK)
  let mimeType: string
  let size: number
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error("Attachments must be files.")
    if (info.size > 100 * 1024 * 1024) throw new Error("Attachments must be 100 MB or smaller.")
    size = info.size
    const header = Buffer.alloc(Math.min(size, 8192))
    await handle.read(header, 0, header.length, 0)
    mimeType = (await fileTypeFromBuffer(header).catch(() => undefined))?.mime ?? Bun.file(source).type ?? "application/octet-stream"
  } finally { await handle.close() }
  const name = path.basename(source)
  const storedName = `attachment-${crypto.randomUUID()}-${name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)}`
  const dir = getTranscriptMediaDir(context.dataDir, context.chatId)
  await mkdir(dir, { recursive: true })
  const destination = path.join(dir, storedName)
  await copyFile(source, destination)
  return {
    destination,
    attachment: { type: "attachment", url: buildTranscriptMediaUrl(context.chatId, storedName), name, kind: attachmentKind(mimeType), mimeType, size },
  }
}

export const DISPLAY_TOOLS: readonly KannaToolDefinition[] = [
  SHOW_VISUALIZATION_TOOL,
  {
    name: "send_attachments",
    description: "Show images, videos, and file links in the chat. Supply local paths or HTTP/HTTPS URLs. Local files are copied into the chat so they remain available after the source changes. Images and videos appear inline; other files appear as download links.",
    schema: attachmentSchema,
    async execute(input, context) {
      const { attachments } = attachmentSchema.parse(input)
      const resolved: DisplayAttachment[] = []
      const copied: string[] = []
      try {
        for (const item of attachments) {
          context.signal.throwIfAborted()
          if (Boolean(item.path) === Boolean(item.url)) throw new Error("Each attachment needs exactly one path or url.")
          if (item.url) {
            const url = new URL(item.url)
            if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Attachment URLs must use HTTP or HTTPS without embedded credentials.")
            const name = decodeURIComponent(url.pathname.split("/").pop() || "attachment")
            const mimeType = Bun.file(name).type || "application/octet-stream"
            const kind = mimeType === "image/svg+xml" ? "file" : item.kind ?? attachmentKind(mimeType)
            resolved.push({ type: "attachment", url: url.href, name, kind, mimeType, size: null })
            continue
          }
          const stored = await storeLocalAttachment(path.resolve(context.cwd, item.path!), context)
          copied.push(stored.destination)
          resolved.push(stored.attachment)
        }
        context.signal.throwIfAborted()
        return {
          content: [{ type: "text", text: `Displayed ${resolved.length} attachment${resolved.length === 1 ? "" : "s"}.` }],
          structuredContent: { displayed: true, attachments: resolved },
          transcriptContent: resolved,
        }
      } catch (error) {
        await Promise.all(copied.map(file => rm(file, { force: true })))
        throw error
      }
    },
  },
]
