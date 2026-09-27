import type { ChatDiffFile } from "../shared/types"

const CONTEXT_LINES = 3

type LineOp = { kind: "same" | "add" | "del"; text: string }

function splitLines(text: string) {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

// Plain LCS. Demo files are a few dozen lines, so the quadratic table is fine
// and keeps this free of a diff dependency the client bundle doesn't need.
function diffLines(before: string[], after: string[]): LineOp[] {
  const rows = before.length + 1
  const cols = after.length + 1
  const table = new Uint16Array(rows * cols)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = before[i] === after[j]
        ? table[(i + 1) * cols + j + 1]! + 1
        : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!)
    }
  }

  const ops: LineOp[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: "same", text: before[i]! })
      i += 1
      j += 1
    } else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) {
      ops.push({ kind: "del", text: before[i]! })
      i += 1
    } else {
      ops.push({ kind: "add", text: after[j]! })
      j += 1
    }
  }
  while (i < before.length) ops.push({ kind: "del", text: before[i++]! })
  while (j < after.length) ops.push({ kind: "add", text: after[j++]! })
  return ops
}

function formatRange(start: number, count: number) {
  return count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`
}

export interface DemoPatch {
  patch: string
  additions: number
  deletions: number
}

/** A git-style unified diff of one file, as `project.readDiffPatch` returns it. */
export function createUnifiedPatch(
  path: string,
  before: string,
  after: string,
  changeType: ChatDiffFile["changeType"],
): DemoPatch {
  const ops = diffLines(splitLines(before), splitLines(after))
  const additions = ops.filter((op) => op.kind === "add").length
  const deletions = ops.filter((op) => op.kind === "del").length

  const header = [`diff --git a/${path} b/${path}`]
  if (changeType === "added") header.push("new file mode 100644")
  if (changeType === "deleted") header.push("deleted file mode 100644")
  header.push(`--- ${changeType === "added" ? "/dev/null" : `a/${path}`}`)
  header.push(`+++ ${changeType === "deleted" ? "/dev/null" : `b/${path}`}`)

  const changed = ops.flatMap((op, index) => (op.kind === "same" ? [] : [index]))
  const hunks: string[] = []
  let cursor = 0
  while (cursor < changed.length) {
    const first = changed[cursor]!
    let last = first
    while (cursor + 1 < changed.length && changed[cursor + 1]! - last <= CONTEXT_LINES * 2) {
      cursor += 1
      last = changed[cursor]!
    }
    cursor += 1

    const start = Math.max(0, first - CONTEXT_LINES)
    const end = Math.min(ops.length, last + CONTEXT_LINES + 1)
    let oldLine = 1
    let newLine = 1
    for (const op of ops.slice(0, start)) {
      if (op.kind !== "add") oldLine += 1
      if (op.kind !== "del") newLine += 1
    }
    const slice = ops.slice(start, end)
    const oldCount = slice.filter((op) => op.kind !== "add").length
    const newCount = slice.filter((op) => op.kind !== "del").length
    hunks.push(`@@ -${formatRange(oldLine, oldCount)} +${formatRange(newLine, newCount)} @@`)
    for (const op of slice) {
      hunks.push(`${op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}${op.text}`)
    }
  }

  return {
    patch: `${[...header, ...hunks].join("\n")}\n`,
    additions,
    deletions,
  }
}
