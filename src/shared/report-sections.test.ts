import { describe, expect, test } from "bun:test"
import { stripSystemMessages } from "./message-preview"
import { isInterimReportStatus, splitReportSections } from "./report-sections"

const header = (status: string, title: string, id: string) =>
  `<system-message>\nSub-chat ${status}: [${title}](/chat/${id}) (chat id ${id})\n</system-message>`

describe("splitReportSections", () => {
  test("one sub-chat's report is one part, named", () => {
    const content = `${header("completed", "Tell me a joke", "abc")}\n\nWhy did the scarecrow win an award?`
    expect(splitReportSections(content, ["abc"])).toEqual([
      { chatId: "abc", body: "Why did the scarecrow win an award?", status: "completed" },
    ])
  })

  test("a merged report splits per sub-chat and drops the rule between them", () => {
    const content = [
      `${header("completed", "Joke", "abc")}\n\nFirst answer`,
      `${header("failed", "Deploy", "def")}\n\n---\n\ncredentials expired`,
    ].join("\n\n")
    expect(splitReportSections(content, ["abc", "def"])).toEqual([
      { chatId: "abc", body: "First answer", status: "completed" },
      { chatId: "def", body: "credentials expired", status: "failed" },
    ])
  })

  test("a sub-chat that said nothing has no part", () => {
    const content = [
      header("cancelled", "Stopped", "abc"),
      `${header("completed", "Deploy", "def")}\n\nshipped`,
    ].join("\n\n")
    expect(splitReportSections(content, ["abc", "def"])).toEqual([{ chatId: "def", body: "shipped", status: "completed" }])
    expect(splitReportSections(header("cancelled", "Stopped", "abc"), ["abc"])).toEqual([])
  })

  test("a rule the first sub-chat wrote itself is kept", () => {
    const content = `${header("completed", "Notes", "abc")}\n\n---\n\nfrontmatter`
    expect(splitReportSections(content, ["abc"])[0]?.body).toBe("---\n\nfrontmatter")
  })

  test("a block naming a chat the report is not about does not start a part", () => {
    const quoted = "<system-message>Sub-chat completed: [Other](/chat/zzz) (chat id zzz)</system-message>"
    const content = `${header("completed", "Audit", "abc")}\n\nI saw this header:\n\n${quoted}\n\nand carried on.`
    expect(splitReportSections(content, ["abc"])).toEqual([
      { chatId: "abc", body: "I saw this header:\n\n\n\nand carried on.", status: "completed" },
    ])
  })

  test("text with no header at all is one unnamed part", () => {
    expect(splitReportSections("just words", ["abc"])).toEqual([{ chatId: null, body: "just words", status: null }])
  })

  test("shows nothing the bubble would not have shown", () => {
    const content = [
      `${header("completed", "Joke", "abc")}\n\nFirst answer`,
      `${header("failed", "Deploy", "def")}\n\n---\n\ncredentials expired`,
    ].join("\n\n")
    const shown = splitReportSections(content, ["abc", "def"]).map((part) => part.body).join("\n\n---\n\n")
    expect(shown).toBe(stripSystemMessages(content))
  })

  // The headers below are the orchestrator's own, as `buildReport` writes them.
  test("an interim report is a part like any other, and says it was not the last word", () => {
    const content = [
      "<system-message>",
      "Sub-chat waiting_on_subchats: [Coordinator](/chat/abc) (chat id abc)",
      'Not its last word. Its turn ended, and it is still waiting on chats under it: "Legwork". What follows is its reply so far. It reports again when its next turn ends.',
      "</system-message>",
      "",
      "Started the legwork.",
    ].join("\n")
    const parts = splitReportSections(content, ["abc"])
    expect(parts).toEqual([{ chatId: "abc", body: "Started the legwork.", status: "waiting_on_subchats" }])
    expect(isInterimReportStatus(parts[0]!.status)).toBe(true)
  })

  test("only a report written while work was still going is interim", () => {
    for (const status of ["running", "waiting_on_subagent", "waiting_on_subchats"]) expect(isInterimReportStatus(status)).toBe(true)
    for (const status of ["completed", "failed", "cancelled", "idle", "needs_input", "adopted", null]) expect(isInterimReportStatus(status)).toBe(false)
  })

  test("a header's extra lines stay in the header: a schedule the sub-chat set itself", () => {
    const content = [
      "<system-message>",
      "Sub-chat completed: [Deploy](/chat/abc) (chat id abc)",
      'It set itself the schedule "Deploy check", which next runs at 2026-10-06T12:00:00.000Z. The turn each run starts is reported here too.',
      "</system-message>",
      "",
      "Deployed. Checking back in an hour.",
    ].join("\n")
    expect(splitReportSections(content, ["abc"])).toEqual([
      { chatId: "abc", body: "Deployed. Checking back in an hour.", status: "completed" },
    ])
  })

  const adopted = (title: string, id: string, adopterTitle: string, adopterId: string) =>
    `<system-message>\nSub-chat adopted: [${title}](/chat/${id}) (chat id ${id}) now reports to the chat "${adopterTitle}" (/chat/${adopterId}), which adopted it. Its result will not arrive here. read_chat and wait_for_chats still reach it.\n</system-message>`

  test("an adoption notice is a part with no words, naming who adopted the chat", () => {
    expect(splitReportSections(adopted("Audit", "abc", "Coordinator", "xyz"), ["abc"])).toEqual([
      { chatId: "abc", body: "", status: "adopted", adoptedByChatId: "xyz" },
    ])
    // The adopter's title can hold anything, a link included.
    expect(splitReportSections(adopted("Audit", "abc", 'A "quoted" (/chat/nope) title', "xyz"), ["abc"])[0]?.adoptedByChatId).toBe("xyz")
  })

  test("an adoption notice among results keeps its place and takes no rule", () => {
    const content = [
      `${header("completed", "Joke", "abc")}\n\nFirst answer`,
      adopted("Audit", "mid", "Coordinator", "xyz"),
      `${header("failed", "Deploy", "def")}\n\n---\n\ncredentials expired`,
    ].join("\n\n")
    expect(splitReportSections(content, ["abc", "mid", "def"])).toEqual([
      { chatId: "abc", body: "First answer", status: "completed" },
      { chatId: "mid", body: "", status: "adopted", adoptedByChatId: "xyz" },
      { chatId: "def", body: "credentials expired", status: "failed" },
    ])
  })

  test("a notice ahead of the first words does not make their own leading rule a divider", () => {
    const content = [
      adopted("Audit", "abc", "Coordinator", "xyz"),
      `${header("completed", "Notes", "def")}\n\n---\n\nfrontmatter`,
    ].join("\n\n")
    expect(splitReportSections(content, ["abc", "def"])[1]?.body).toBe("---\n\nfrontmatter")
  })
})
