/**
 * What stands in for a project's icon when it has none: its initials on a
 * colour. Both come from the name alone, so a project looks the same in every
 * browser and after every restart. React-free for tests.
 */

/** Dark enough for white text, and far enough apart to tell two projects by. */
const MONOGRAM_COLORS = [
  "#dc2626", "#ea580c", "#b45309", "#4d7c0f", "#15803d", "#0f766e",
  "#0e7490", "#0369a1", "#1d4ed8", "#4f46e5", "#7c3aed", "#a21caf",
  "#be185d", "#be123c", "#57534e", "#475569",
]

/**
 * A name's words, whichever way it joins them: `snake_case`, `kebab-case`,
 * `camelCase`, `TitleCase`, `dotted.name`, or plain spaces. A run of capitals
 * is one word (`HTTPServer` is HTTP and Server) and digits stay with the
 * letters before them (`t3code` is one word).
 */
export function splitProjectWords(name: string): string[] {
  return name
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/** Two initials for a name of several words, the first letter for a single word. */
export function getProjectInitials(name: string): string {
  const words = splitProjectWords(name)
  if (words.length === 0) {
    // Nothing to read as a word: an emoji, or punctuation. Its first character will do.
    return Array.from(name.trim())[0] ?? "?"
  }
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]!.toUpperCase())
    .join("")
}

/** FNV-1a. Small, and spreads names that differ by one character. */
function hashName(name: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

export function getProjectColor(name: string): string {
  return MONOGRAM_COLORS[hashName(name) % MONOGRAM_COLORS.length]!
}
