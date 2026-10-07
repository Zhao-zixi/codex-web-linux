import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"

/**
 * What a model is told about `show_visualization`, in the two places it is told.
 *
 * The tool's description is not the place for the contract. Claude Code cuts
 * every MCP tool description, and a server's instructions, at
 * `KANNA_TOOL_DESCRIPTION_LIMIT` characters and ends it "[truncated]". At
 * 8,000 characters this one reached Claude as its first quarter, and an agent
 * that saw the mark went and read the rest out of Kanna's installed bundle.
 * So the description is short, opens with what decides the first lines of
 * markup, and names where the rest is: the session instructions, which every
 * harness gets whole (`harness-instructions.ts`). Every chat pays for those,
 * drawing or not, which is the price of a model never having to go and ask.
 */

// A tool preference alone does not stop providers loading their bundled skills
// first. Those skills bring a different renderer or workflow into the same turn.
export const KANNA_VISUALIZATION_SKILL_INSTRUCTIONS = [
  "For in-chat visualizations in Kanna, do not automatically invoke, load, read, or follow Claude's /dataviz skill (also referred to as /datavis), Codex's /visualize or /visualize:visualize skill, or equivalent provider-specific visualization/artifact skills. A request for a chart, diagram, simulation, or UI prototype is not a request to use those skills. Use show_visualization directly; its tool description and these Kanna instructions are the complete authoring contract, with no prerequisite visualization skill.",
  "Those skills may assume a different output marker, host runtime, CSS utilities, palette, fonts, network access, or testing workflow. Kanna does not provide window.openai, Tweak, a global lucide, Codex visualization utilities, or CDN loading. Use Kanna's documented theme variables, self-contained HTML/CSS/JavaScript, and supported bridge APIs. Do not import a provider's rendering wrapper or stylesheet, substitute its default palette or fonts, or run browser previews merely because a skill recommends them; follow the user's workspace testing rules.",
  "If the user explicitly asks to inspect or use one of those skills, you may read it, but adapt any in-chat result to show_visualization's contract. This routing rule is for inline conversation content; requested standalone files, websites, project changes, and static exports should still follow the user's requested deliverable.",
].join("\n\n")

const corner = `${VISUALIZATION_EXPAND_BUTTON.clear}px`

// Condensed from the prototype skill for the in-chat surface. URL persistence and
// page-level picker placement need different rules inside an opaque, auto-sized iframe.
const prototypeExample = `<header style="padding-right:${corner}"><h3>Save a draft</h3><p class="text-muted">Two ways to confirm</p></header>
<div class="kanna-segmented" role="radiogroup" aria-label="Direction"><button role="radio" onclick="mount('Direct')">Direct</button><button role="radio" onclick="mount('Confirm')">Confirm</button></div>
<section id="stage" style="height:40px"></section>
<script>
function mount(mode) {
  for (const option of document.querySelectorAll('[role=radio]')) option.setAttribute('aria-checked', option.textContent === mode);
  stage.innerHTML = (mode === 'Confirm' ? '<label><input type="checkbox"> Ready</label> ' : '') + '<button>Save draft</button>';
}
mount('Direct');
</script>`

const KANNA_VISUALIZATION_PROTOTYPE_INSTRUCTIONS = [
  "UI prototypes: show_visualization is also an isolated, interactive prototype surface. When asked to explore a UI, scope one component or flow and read its product context and tokens. Default to 3 genuinely different directions (up to 5 when requested), each named for a distinct layout, density, personality, motion, or interaction model; color/copy-only variations do not count.",
  "Render one direction at a time at realistic size and in realistic surrounding context, behind a kanna-segmented picker with instant swaps, on its own row under the header so it cannot cover the work. Support touch/click and number/arrow keys; ignore shortcuts while editing inputs or holding modifiers. Keep the selection in memory: there is no URL, history or localStorage in the sandbox. Give the stage one fixed height, the tallest direction's, so switching never changes the page's height.",
  "Every direction needs working local interactions, realistic copy, and explicit simulated backend/AI behavior where appropriate; do not imply a demo sends messages, generates real images, or saves production data. Cards, dialogs, and other surfaces being prototyped are allowed inside the otherwise unframed result. Prefer sub-300ms transform/opacity motion, ease-out entrances, reduced-motion support, and a replay control when useful.",
  "Keep exploration inside the visualization; do not change production code until the user chooses a direction. Explain each direction's benefit and cost, then wait for that choice. After explicit selection, integrate only the winner and remove temporary prototype source files unless asked to keep them.",
  `A two-direction picker, as small as it gets (an exploration normally has three):\n${prototypeExample}`,
].join("\n")

/** The whole authoring contract. In the session instructions, under "Kanna visualizations". */
export const KANNA_VISUALIZATION_CONTRACT = [
  "Author self-contained HTML with inline CSS, JavaScript, and data. Supply html or a local path to show_visualization. External scripts, stylesheets, fonts, images, fetches, local file access, storage APIs, and nested frames are unavailable, and a document that references an external script, stylesheet or image is rejected. Images and fonts work as data: URIs, and the whole document can be 2 MB. Plain SVG and JavaScript work well; bundle any library you need inline. The tool stores a snapshot, so publish again after changing a source file.",
  `Start the markup with a header at the top left: an h3 title that names what is shown and a p class="text-muted" subtitle with its scope, period or unit. Keep the top-right ${corner} by ${corner} clear: the host lays a ${VISUALIZATION_EXPAND_BUTTON.size}px expand button over that corner, on hover and always on touch screens, so put nothing important or interactive there (no control, legend, key figure or close button) and stop the header's text short of it, e.g. padding-right:${corner}.`,
  "Controls go on their own row under the header, never beside the title. For a visualization's own settings (time range, metric, series, grouping, chart type, units) use the host's two styled controls, not an ad-hoc row of buttons or a native <select>. A few mutually exclusive options are a segmented control: <div class=\"kanna-segmented\" role=\"radiogroup\" aria-label=\"Range\"><button role=\"radio\" aria-checked=\"true\">7d</button><button role=\"radio\" aria-checked=\"false\">30d</button><button role=\"radio\" aria-checked=\"false\">90d</button></div>. Switching whole views (Revenue / Users) is tabs: class=\"kanna-tabs\" role=\"tablist\" with role=\"tab\" aria-selected buttons. Both are styled from the aria state, so set it on click; keep <select> for more than about six options.",
  "The host supplies typography and live light/dark colors. Body text is 16px and inherited: keep prose, table cells, control labels and headline numbers at that size or larger, and go smaller only for axis ticks, legends and secondary labels, never under 12px. Use var(--font-sans) and var(--font-mono) only when an explicit font is needed. Use CSS variables directly as colors: --foreground, --background, --muted-foreground, --border, --surface, and --viz-red, --viz-green, --viz-blue, --viz-yellow, --viz-orange, --viz-purple, --viz-pink, --viz-teal (also --chart-1 through --chart-8). Do not wrap these in hsl(). Use neutral labels and colored marks; avoid hardcoded light/dark backgrounds. For canvas, read colors and fonts from computed styles, wait for document.fonts.ready, and redraw on the kanna:themechange event; changing CSS alone does not repaint canvas pixels.",
  `Make the content feel like part of the reply: keep html, body and the outer wrapper transparent, with no outer card, border, shadow, page padding, or oversized headline; filled surfaces are for controls, tooltips and UI being prototyped. Use the available width, natural document height, and a responsive layout down to 320px. Avoid 100vh and percentage page heights because the host sizes the frame to its contents. Give charts a fixed pixel height with fluid width and recompute their layout on ResizeObserver; do not merely shrink an SVG full of text. The frame fits the content up to ${VISUALIZATION_MAX_HEIGHT}px; anything taller scrolls inside the frame with no scrollbar showing, so paginate long content or put it behind tabs.`,
  "The page's height must never change after it first renders. No interaction may grow or shrink it: a tab, toggle, filter, opened row, added text, validation message or tooltip all have to fit in the height the page already has, because a frame that changes height moves the whole conversation under the reader. Size the page for its tallest state up front: give every area that swaps content one fixed height (the tallest view's), reserve the room for anything that appears later, lay tooltips and popovers over the content instead of inserting them into the flow, and let a list that can grow scroll inside its own fixed-height box.",
  "Use touch-friendly controls, readable labels, keyboard navigation, and reduced-motion support. On iOS the inline result is a live picture that opens full screen on a tap, so make the first view useful before any interaction. A vertical drag scrolls the page unless the element under the finger sets touch-action: none; put that on the draggable element itself (a handle, a vertical slider, a drawing surface), never on the whole chart or the page, or the reader cannot scroll past it.",
  "For charts, include units, useful hover/tap details, source/denominator caveats, and optionally CSV export using window.kanna.download({filename: 'data.csv', content: csvText, mimeType: 'text/csv'}) in a click handler. The same API supports text/plain and application/json, up to 2 MB, and opens the native share sheet on iOS. Do not use blob download links. Separate panels with a shared time axis are often clearer than unrelated dual y-axes. Keep explanations outside the visualization when ordinary Markdown communicates them better.",
  "After the tool succeeds, the visualization is already visible. Do not also emit a provider marker, screenshot, raw HTML, or file link unless requested.",
  KANNA_VISUALIZATION_PROTOTYPE_INSTRUCTIONS,
].join("\n")

/**
 * What the tool's own description says. In order of what a model needs before
 * it writes the first line, because a harness with a lower limit than Claude
 * Code's would cut it from the end.
 */
export const SHOW_VISUALIZATION_DESCRIPTION = [
  "Render self-contained interactive HTML inline in the conversation on web and iOS, with no card: charts, diagrams, tables, calculators, simulations, UI prototypes. Use it, not a provider's visualization skill, artifact or chart image. The full contract is in your instructions under \"Kanna visualizations\"; the essentials are here.",
  "- Supply an HTML fragment with inline CSS, JavaScript and data. Nothing external loads: no CDN, script src, stylesheet, font, image URL, fetch or storage.",
  `- Start with a header at the top left: an h3 title naming what is shown and a p class="text-muted" subtitle with its scope, period or unit. Keep the top-right ${corner} by ${corner} clear, since the host lays an expand button there: no control, legend or key figure in it, and give the header padding-right:${corner}.`,
  "- Controls go on their own row under the header: class=\"kanna-segmented\" (role=radiogroup, buttons with role=radio and aria-checked) for a few exclusive options, class=\"kanna-tabs\" (role=tablist, role=tab, aria-selected) for whole views. Not custom button rows or <select>.",
  "- Colors are CSS variables, used directly: --foreground, --background, --muted-foreground, --border, --surface, --viz-red/green/blue/yellow/orange/purple/pink/teal, --chart-1 to --chart-8. Keep html, body and the outer wrapper transparent, with no outer card, border or page padding.",
  "- Body text is 16px and inherited. Only axis ticks, legends and secondary labels go smaller, never under 12px.",
  `- Fluid width from 320px, natural height, no 100vh; give charts a fixed pixel height. The frame fits the content up to ${VISUALIZATION_MAX_HEIGHT}px and scrolls inside past that, so paginate or tab long content.`,
  "- The height must never change after load: no click, toggle or tab may grow or shrink the page. Size it for its tallest state; swap content inside fixed-height areas.",
  "- On iOS the inline result is a live picture that opens full screen on a tap: make the first view useful without interaction.",
  "Once it succeeds it is already visible; do not also send a screenshot, file or raw HTML.",
].join("\n")
