/**
 * Kanna's git attribution — one source of truth for two very different surfaces.
 *
 * Harness commits (advisory): buildKannaAttributionInstructions is appended to
 * each provider's system prompt (via harness-instructions.ts) — natively for
 * claude (systemPrompt.append), pi (DefaultResourceLoader.appendSystemPrompt)
 * and codex (collaborationMode.settings.developer_instructions). Cursor and
 * grok expose no append hook, so they ride the same user-text <system-message>
 * path the skill failsafe uses. All of these are instructions to a model:
 * compliance is high but not guaranteed.
 *
 * Kanna's own commits (deterministic): buildKannaCommitAttribution is applied in
 * diff-store.commitFiles just before git runs, so anything committed from the
 * git sidebar is attributed by construction, not by persuasion. Those carry no
 * agent trailer — no agent ran.
 *
 * The agent id is baked into the instructions, so it costs nothing per turn.
 * Codex and cursor rebuild theirs every turn and are always current. Claude and
 * pi bake theirs at session start and drift when setModel() swaps the model on
 * a live session, so those two append buildKannaAgentCorrection to the turn
 * text from the drift onward — a bare value, because the rule is already in
 * their (cached) system prompt.
 *
 * Note the link is markdown in PR bodies and a bare URL in commits: GitHub
 * renders markdown in PR descriptions, but commit messages are plain text
 * everywhere — bare URLs autolink, `[text](url)` would show up literally.
 */

export const KANNA_COMMIT_TRAILER = "Co-Authored-By: Kanna <noreply@kanna.sh>"

export const KANNA_COMMIT_FOOTER = "🌸 Shipped with Kanna — https://kanna.sh"

/**
 * Git trailer key for the harness+model that wrote the commit. A trailer rather
 * than a suffix on the footer line for three reasons: KANNA_COMMIT_FOOTER stays
 * byte-stable (KANNA_FOOTER_PATTERN below keys off its literal prefix, so any
 * wording change there silently breaks dedupe), the last paragraph stays a pure
 * `key: value` block that `git interpret-trailers` can parse, and the
 * deterministic sidebar path can simply omit it.
 */
export const KANNA_AGENT_TRAILER_KEY = "Kanna-Agent"

/**
 * `<provider>/<model>` — e.g. `claude/claude-opus-5`. Raw ids, not display
 * labels: this is a stable key meant to survive aggregation, and a
 * harness→label map would rot. Splitting on the first `/` recovers the harness
 * even for providers whose own model ids contain one (opencode ships
 * `<vendor>/<model>`, giving three segments).
 */
export function buildKannaAgentId(provider: string, model: string): string {
  return `${provider}/${model}`
}

export function buildKannaAgentTrailer(agentId: string): string {
  return `${KANNA_AGENT_TRAILER_KEY}: ${agentId}`
}

/**
 * The pitch lives here and not in KANNA_COMMIT_FOOTER on purpose: a PR body is
 * read once, by someone who may never have heard of Kanna. Commit messages are
 * permanent, show up in `git blame`, and GitHub's squash merge concatenates
 * every message on the branch — a tagline there would ship N times per PR.
 */
export function buildKannaPrFooter(agentId: string): string {
  return `🌸 Shipped with [Kanna](https://kanna.sh) — an open-source workspace for all your coding agents. Written by \`${agentId}\`.`
}

export function buildKannaAttributionInstructions(agentId: string): string {
  return `# Git attribution

End every git commit message you write with a footer line and a trailer block, separated from the rest of the message and from each other by a blank line so the trailer block stays last:

${KANNA_COMMIT_FOOTER}

${KANNA_COMMIT_TRAILER}
${buildKannaAgentTrailer(agentId)}

End every pull request body you write with this line:

${buildKannaPrFooter(agentId)}

This is the only attribution to use. Do not add a co-author trailer, a "Generated with" footer, or a session link for yourself, for your model, or for the CLI you are running as — Kanna's attribution replaces them.`
}

/**
 * Carries only the value — the rule is already in the system prompt, and this
 * one rides every turn from the drift onward. Sticky rather than emitted once:
 * a single correction drifts backwards through the history while the system
 * prompt keeps asserting the stale id, and compaction eventually drops it,
 * whereas the newest user turn survives compaction by construction.
 */
export function buildKannaAgentCorrection(agentId: string): string {
  return `<system-message>Git attribution: the agent id is now \`${agentId}\`. Use it in the ${KANNA_AGENT_TRAILER_KEY} trailer and the pull request footer.</system-message>`
}

/**
 * Both matchers are line-anchored so a mention inside prose (a commit that
 * documents the attribution, say) never counts as the attribution itself. The
 * trailer token is matched case-insensitively: git writes `Co-authored-by`,
 * agents tend to write `Co-Authored-By`, and either should suppress a duplicate.
 */
const KANNA_TRAILER_PATTERN = /^co-authored-by:\s*kanna\s*<noreply@kanna\.sh>$/i
const KANNA_FOOTER_PATTERN = /^\u{1F338}?\s*shipped with kanna\b.*$/iu

function matchesLine(message: string, pattern: RegExp): boolean {
  return message.split("\n").some((line) => pattern.test(line.trim()))
}

export function hasKannaTrailer(message: string): boolean {
  return matchesLine(message, KANNA_TRAILER_PATTERN)
}

export function hasKannaFooter(message: string): boolean {
  return matchesLine(message, KANNA_FOOTER_PATTERN)
}

/**
 * The attribution block missing from `message`, or null when it already carries
 * both parts. Each part is checked independently so a half-attributed message
 * gains only what it lacks. Never emits an agent trailer: the only caller is
 * the git sidebar, where no agent wrote the commit.
 */
export function buildKannaCommitAttribution(message: string): string | null {
  const parts: string[] = []
  if (!hasKannaFooter(message)) parts.push(KANNA_COMMIT_FOOTER)
  if (!hasKannaTrailer(message)) parts.push(KANNA_COMMIT_TRAILER)
  return parts.length > 0 ? parts.join("\n\n") : null
}

/** Idempotent: appends whatever attribution is missing as trailing paragraphs. */
export function appendKannaAttribution(message: string): string {
  const trimmed = message.trim()
  const attribution = buildKannaCommitAttribution(trimmed)
  if (!attribution) return trimmed
  return trimmed.length > 0 ? `${trimmed}\n\n${attribution}` : attribution
}
