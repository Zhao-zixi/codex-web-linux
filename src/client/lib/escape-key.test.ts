import { describe, expect, test } from "bun:test"
import { resolveEscapePress, type EscapePress } from "./escape-key"

function press(overrides: Partial<EscapePress>): EscapePress {
  return { repeat: false, claimed: false, paneOpen: false, canInterrupt: false, ...overrides }
}

describe("resolveEscapePress", () => {
  test("something nearer the key keeps it, whatever else is true", () => {
    expect(resolveEscapePress(press({ claimed: true }))).toBe("pass")
    expect(resolveEscapePress(press({ claimed: true, paneOpen: true, canInterrupt: true }))).toBe("pass")
    expect(resolveEscapePress(press({ claimed: true, paneOpen: true, repeat: true }))).toBe("pass")
  })

  test("an open pane closes, with or without a turn running", () => {
    expect(resolveEscapePress(press({ paneOpen: true }))).toBe("close-pane")
    expect(resolveEscapePress(press({ paneOpen: true, canInterrupt: true }))).toBe("close-pane")
  })

  test("with no pane, a running turn starts the hold", () => {
    expect(resolveEscapePress(press({ canInterrupt: true }))).toBe("hold-to-interrupt")
  })

  test("with no pane and no turn, the press is somebody else's", () => {
    expect(resolveEscapePress(press({}))).toBe("pass")
  })

  test("a hold that outlasts its turn is not passed on as a fresh press", () => {
    // The turn stopped while the key was still down: nothing left to close or
    // stop, and the repeat must not reach whoever is last in line for Escape.
    expect(resolveEscapePress(press({ repeat: true }))).toBe("ignore")
  })

  test("a key still held never acts again", () => {
    // Over an open pane: one press closes one thing.
    expect(resolveEscapePress(press({ paneOpen: true, repeat: true }))).toBe("ignore")
    // The press that closed the pane, still down once it is gone: no hold.
    expect(resolveEscapePress(press({ canInterrupt: true, repeat: true }))).toBe("ignore")
  })

  test("the press that closed a menu, still held, does not go on to the pane", () => {
    expect(resolveEscapePress(press({ claimed: true, paneOpen: true }))).toBe("pass")
    expect(resolveEscapePress(press({ paneOpen: true, repeat: true }))).toBe("ignore")
  })
})
