import { describe, expect, test } from "bun:test"
import { isSubChat } from "./sub-chat"

describe("isSubChat", () => {
  test("is a chat with a parent that started it, and never one a parent adopted", () => {
    expect(isSubChat({})).toBe(false)
    expect(isSubChat({ parentChatId: null })).toBe(false)
    expect(isSubChat({ parentChatId: "parent" })).toBe(true)
    // Adopted: the user's own chat, or one born a sub-chat and adopted since.
    expect(isSubChat({ parentChatId: "parent", adopted: true })).toBe(false)
  })
})
