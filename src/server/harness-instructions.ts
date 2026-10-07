import { KANNA_CHAT_LINK_INSTRUCTIONS } from "../shared/chat-links"
import { buildKannaAttributionInstructions } from "./attribution"
import { KANNA_VISUALIZATION_SKILL_INSTRUCTIONS } from "./visualization-instructions"

/**
 * How to use the chat tools in `kanna-orchestration-tools.ts`. The tool
 * descriptions say what each one does; this says which to reach for, which
 * the descriptions cannot do one tool at a time.
 */
export const KANNA_ORCHESTRATION_INSTRUCTIONS = [
  "# Kanna chats",
  "",
  "The `kanna` tools let you do what the user can do in Kanna: start chats, message them, read them, stop them, and schedule messages. Tool names may carry a prefix such as `mcp__kanna__`.",
  "",
  "- A sub-chat is a chat you start with `create_chat`. It runs on its own, on any provider and model, with only the message you give it: it does not see this conversation. Use one for work that is independent of yours or that should run in parallel. For small same-model help, your own subagent tool is cheaper.",
  "- Sub-chats are asynchronous. `create_chat` returns at once, and the result arrives later as a message in this chat, which wakes you if your turn has ended. So you can start several, finish your turn, and be called back.",
  "- A sub-chat reports when its turn ends. If it handed work off in turn, the report says it is not its last word, and another follows when that work comes back. Read the first as progress, not as the result.",
  "- Call `wait_for_chats` only when your next step needs the answer. A wait that times out does not stop the chat; wait again, read it with `read_chat`, or carry on and let the result come as a message.",
  "- Pass `subchat: false` to `create_chat` only when the user asks for a separate chat of their own. It reports nothing back.",
  "- `fork_chat` copies a conversation, context included. `create_chat` starts empty.",
  "- `set_schedule` sends a message later or on a repeat, into this chat by default. Use it to check on something in a while instead of sleeping.",
  "- `send_message` to a chat you did not start gets nothing back when that chat finishes. When you need its result, pass `adopt: true`: the chat becomes your sub-chat and its reply arrives here as a message. An adopted chat is still the user's, so it stays in their sidebar.",
  "- Stopping this chat stops the sub-chats it started, not ones it adopted. Stop one yourself with `cancel_chat` when it is no longer needed.",
].join("\n")

export const KANNA_VISUALIZATION_INSTRUCTIONS = [
  "# Kanna visualizations",
  "",
  "Prefer Kanna's `show_visualization` tool for visual explanations and interactive content: UI prototypes and design variants, charts, diagrams, timelines, calculators, simulations, comparisons, and tools. It renders directly alongside your Markdown on web and iOS, without a card. Use it proactively when a visual or interaction makes the answer easier to understand; simple answers can stay text.",
  "Use Kanna's visualization tools over your provider's own visualization or artifact tools. Provider-specific markers (including Codex visualize markers), artifact blocks, and HTML code fences do not render as interactive content here. The old show_chart tool is retired; use show_visualization for new work.",
  KANNA_VISUALIZATION_SKILL_INSTRUCTIONS,
  "Generally do not generate charts or diagrams as PNGs/screenshots and send them with send_attachments. Prefer a live visualization. Use images for photographs and illustrations, or when the user explicitly asks for an image/static export; use file attachments for requested downloadable deliverables.",
  "Author self-contained HTML with inline CSS, JavaScript, and data. Supply html or a local path to show_visualization. External scripts, fonts, fetches, local file access, storage APIs, and nested frames are unavailable. Plain SVG and JavaScript work well; bundle any library you need inline. The tool stores a snapshot, so publish again after changing a source file.",
  "The host already supplies typography (16px body text) and light/dark colors. Use CSS variables directly as colors: --foreground, --background, --muted-foreground, --border, --surface, and --viz-red, --viz-green, --viz-blue, --viz-yellow, --viz-orange, --viz-purple, --viz-pink, --viz-teal (also --chart-1 through --chart-8). Do not wrap these in hsl(). Use neutral labels and colored marks; avoid hardcoded light/dark backgrounds. Canvas can redraw on the kanna:themechange event.",
  "Make the content feel like part of the reply: no outer card, border, shadow, page padding, or oversized headline. Open it with a compact title and subtitle at the top left and keep its top-right corner clear, as the tool description says: the host puts an expand button there. Use the available width, natural document height, and a responsive layout down to 320px. Avoid 100vh and percentage page heights because the host sizes the frame to its contents. Size charts explicitly within the flow and recompute their layout on ResizeObserver; do not merely shrink an SVG full of text.",
  "Use touch-friendly controls, readable labels, keyboard navigation, and reduced-motion support. Put a chart's own settings (range, metric, series, chart type) in the kanna-segmented control or kanna-tabs the tool description gives, not in a row of custom buttons or a <select>. For charts, include units, useful hover/tap details, source/denominator caveats, and optionally CSV export using window.kanna.download({filename: 'data.csv', content: csvText, mimeType: 'text/csv'}) in a click handler. The same API supports text/plain and application/json, up to 2 MB, and opens the native share sheet on iOS. Do not use blob download links. Separate panels with a shared time axis are often clearer than unrelated dual y-axes. Keep explanations outside the visualization when ordinary Markdown communicates them better.",
  "After the tool succeeds, the visualization is already visible. Do not also emit a provider marker, screenshot, raw HTML, or file link unless requested.",
].join("\n")

/**
 * Everything Kanna tells a harness that holds for the whole session. It goes
 * in the system prompt where the provider has an append hook (claude, pi,
 * codex), so it is cached there instead of being re-sent in every user turn.
 * Only notices that change turn to turn (skills, concurrent agents, steer)
 * belong on the user-text path. See attribution.ts for the per-provider hooks.
 *
 * `tools: false` is for a harness that is not handed the Kanna tools, which
 * must not be told to call them.
 */
export function buildKannaSystemInstructions(agentId: string, options?: { tools?: boolean }): string {
  return [
    buildKannaAttributionInstructions(agentId),
    KANNA_CHAT_LINK_INSTRUCTIONS,
    ...(options?.tools === false ? [] : [KANNA_ORCHESTRATION_INSTRUCTIONS, KANNA_VISUALIZATION_INSTRUCTIONS]),
  ].join("\n\n")
}

/** Wrapped for the providers that have no system-prompt append hook (cursor, grok). */
export function buildKannaSystemMessage(agentId: string, options?: { tools?: boolean }): string {
  return `<system-message>${buildKannaSystemInstructions(agentId, options)}</system-message>`
}
