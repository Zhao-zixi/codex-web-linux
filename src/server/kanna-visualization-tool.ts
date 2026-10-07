import { z } from "zod"
import { constants } from "node:fs"
import { mkdir, open, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_BYTES, VISUALIZATION_MAX_HEIGHT, VISUALIZATION_TOOL_NAME, type VisualizationArtifact } from "../shared/visualization"
import { buildTranscriptMediaUrl, getTranscriptMediaDir } from "./transcript-media"
import { buildVisualizationDocument } from "./visualization-document"
import { KANNA_VISUALIZATION_SKILL_INSTRUCTIONS } from "./visualization-instructions"
import type { KannaToolDefinition } from "./kanna-tools"

const schema = z.strictObject({
  title: z.string().min(1).max(200).describe("Accessible name for the visualization. No title bar is added."),
  html: z.string().min(1).max(VISUALIZATION_MAX_BYTES).optional().describe("Self-contained HTML fragment, including inline CSS and JavaScript. Supply html or path, not both."),
  path: z.string().min(1).optional().describe("HTML file, absolute or relative to the project. Copied into this chat; source edits will not change the saved visualization."),
  height: z.number().int().min(80).max(VISUALIZATION_MAX_HEIGHT).optional().describe("Initial height in CSS pixels, default 360. The frame then fits the content automatically."),
})

// Early in the description: it decides the first lines of markup. The corner's
// size comes from the button itself (`VISUALIZATION_EXPAND_BUTTON`).
const corner = `${VISUALIZATION_EXPAND_BUTTON.clear}px`
const headerInstructions = `Start with a header at the top left: a title that names what is shown and a subtitle with its scope, period or unit (an h3 and a p class=\"text-muted\"). Keep the top-right ${corner} by ${corner} clear: the host lays a ${VISUALIZATION_EXPAND_BUTTON.size}px expand button over that corner on hover, so put nothing important or interactive there (no control, legend, key figure or close button) and stop the header's text short of it, e.g. padding-right:${corner}. Controls (kanna-segmented, kanna-tabs, below) go on their own row under the header, never beside the title.`

// Condensed from the prototype skill for the in-chat surface. URL persistence and
// page-level picker placement need different rules inside an opaque, auto-sized iframe.
const prototypeExample = {
  title: "Save draft interaction prototypes",
  html: `<header style="padding-right:${corner}"><h3>Save a draft</h3><p class="text-muted">Two ways to confirm</p></header>
<div class="kanna-segmented" role="radiogroup" aria-label="Prototype direction"><button role="radio" onclick="mount('Direct')">Direct</button><button role="radio" onclick="mount('Confirm')">Confirm</button></div>
<section id="stage" style="padding-block:12px"></section><p id="status" role="status"></p>
<script>
const stage = document.getElementById('stage'), status = document.getElementById('status');
function save() { status.textContent = 'Draft saved in this preview (simulated).'; }
function mount(mode) {
  for (const option of document.querySelectorAll('[role=radio]')) option.setAttribute('aria-checked', option.textContent === mode);
  status.textContent = '';
  stage.innerHTML = mode === 'Confirm'
    ? '<label><input type="checkbox"> Ready to save</label> <button type="button">Save draft</button>'
    : '<button type="button">Save draft</button>';
  stage.querySelector('button').onclick = () => {
    if (mode === 'Confirm' && !stage.querySelector('input').checked) { status.textContent = 'Confirm you are ready first.'; return; }
    save();
  };
}
mount('Direct');
</script>`,
}

const prototypeInstructions = [
  "UI prototypes: this tool is also an isolated, interactive prototype surface, not just a chart renderer. When asked to explore a UI, scope one component or flow and read its product context and tokens. Default to 3 genuinely different directions (up to 5 when requested), each named for a distinct layout, density, personality, motion, or interaction model; color/copy-only variations do not count.",
  "Render one direction at a time at realistic size and in realistic surrounding context, behind a kanna-segmented picker (below) with instant swaps. Support touch/click and number/arrow keys; ignore shortcuts while editing inputs or holding modifiers. Keep picker selection in memory: do not rely on URL/history updates or localStorage in the sandbox. Put the picker on its own row under the header so it cannot cover the work, and give the prototype stage a natural or explicit height rather than 100vh.",
  "Every direction needs working local interactions, realistic copy, and explicit simulated backend/AI behavior where appropriate; do not imply a demo sends messages, generates real images, or saves production data. Use the host theme tokens; cards, dialogs, and other surfaces being prototyped are allowed inside the otherwise unframed result. Prefer sub-300ms transform/opacity motion, ease-out entrances, correct transform origins, reduced-motion support, and a replay control when useful.",
  "Keep exploration inside the visualization; do not change production code until the user chooses a direction. Explain each direction's benefit and cost, then wait for that choice. After explicit selection, integrate only the winner and remove temporary prototype source files unless asked to keep them. Respect workspace rules on browser testing and say what you actually verified.",
  `Small two-direction interaction example (a full exploration normally has three): show_visualization(${JSON.stringify(prototypeExample)})`,
].join("\n\n")

export const SHOW_VISUALIZATION_TOOL: KannaToolDefinition = {
  name: VISUALIZATION_TOOL_NAME,
  description: KANNA_VISUALIZATION_SKILL_INSTRUCTIONS + "\n\n" + "Render an interactive HTML visualization directly in the conversation on web and iOS, without a card. Use for UI prototypes and design variants, charts, diagrams, explanations, calculators, simulations, timelines, tables, and other interactive content. " + headerInstructions + " Inline all data, scripts and styles; no network, local files, external dependencies, or storage APIs are available. Use Kanna's CSS color variables directly: var(--foreground), var(--background), var(--muted-foreground), var(--border), var(--surface), var(--viz-red), var(--viz-green), var(--viz-blue), var(--viz-yellow), var(--viz-orange), var(--viz-purple), var(--viz-pink), var(--viz-teal). --chart-1 through --chart-8 are series aliases. The host supplies typography and live light/dark colors. Body text is 16px: keep prose, table cells, control labels and headline numbers at that size or larger, and go smaller only for axis ticks, legends and secondary labels, never under 12px. Inherit the font; use var(--font-sans) and var(--font-mono) only when an explicit font is needed. Keep html, body, and the outer wrapper transparent; reserve filled surfaces for controls, tooltips, and UI elements being prototyped. Make content responsive from 320px, use natural document height, and avoid outer cards, page margins, fixed page widths, or viewport-relative heights. Give charts a fixed pixel height with fluid width so they stay readable in the reply column. For a visualization's own settings (time range, metric, series, grouping, chart type, units) use the host's two styled controls, not an ad-hoc row of buttons or a native <select>. A few mutually exclusive options are a segmented control under the header, above the chart: <div class=\"kanna-segmented\" role=\"radiogroup\" aria-label=\"Range\"><button role=\"radio\" aria-checked=\"true\">7d</button><button role=\"radio\" aria-checked=\"false\">30d</button><button role=\"radio\" aria-checked=\"false\">90d</button></div>. Switching whole views (Revenue / Users) is tabs: class=\"kanna-tabs\" role=\"tablist\" with role=\"tab\" aria-selected buttons. Both are styled from the aria state, so set it on click; keep <select> for more than about six options. Include touch and keyboard interactions. On iOS the inline result is a live picture that opens full screen on a tap, so make the first view useful before any interaction. A vertical drag scrolls the page unless the element under the finger sets touch-action: none; put that on the draggable element itself (a handle, a vertical slider, a drawing surface), never on the whole chart or the page, or the reader cannot scroll past it. For canvas, read colors and fonts from computed styles, wait for document.fonts.ready, and redraw on kanna:themechange; changing CSS alone does not repaint canvas pixels. For exports call window.kanna.download({filename, content, mimeType}) from a click handler; text/csv, application/json, and text/plain are supported up to 2 MB on both clients. Returns a durable inline result; do not also send a screenshot or provider-specific visualization marker." + "\n\n" + prototypeInstructions,
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
