import { describe, expect, test } from "bun:test"
import { DEFAULT_RIGHT_SIDEBAR_SIZE } from "../../stores/rightSidebarStore"
import { getWidgetsColumnWidthPx } from "./WidgetsColumn"

describe("getWidgetsColumnWidthPx", () => {
  test("keeps the width it was given", () => {
    expect(getWidgetsColumnWidthPx(420, 1_200)).toBe(420)
  })

  test("keeps the column at its minimum width", () => {
    expect(getWidgetsColumnWidthPx(100, 1_200)).toBe(370)
  })

  test("stops at the left sidebar's maximum width", () => {
    expect(getWidgetsColumnWidthPx(1_200, 2_000)).toBe(520)
  })

  test("leaves the chat its minimum share of a narrow page", () => {
    expect(getWidgetsColumnWidthPx(520, 400)).toBe(320)
  })

  test("uses its bounds alone before the page has a width", () => {
    expect(getWidgetsColumnWidthPx(1_200, 0)).toBe(520)
  })

  test("falls back to the default for a width that isn't a number", () => {
    expect(getWidgetsColumnWidthPx(Number.NaN, 1_200)).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })
})
