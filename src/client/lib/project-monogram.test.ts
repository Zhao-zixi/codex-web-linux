import { describe, expect, test } from "bun:test"
import { getProjectColor, getProjectInitials, splitProjectWords } from "./project-monogram"

describe("getProjectInitials", () => {
  test("reads every way of joining words", () => {
    expect(getProjectInitials("kanna-site")).toBe("KS")
    expect(getProjectInitials("my_cool_app")).toBe("MC")
    expect(getProjectInitials("camelCaseName")).toBe("CC")
    expect(getProjectInitials("TitleCaseName")).toBe("TC")
    expect(getProjectInitials("Sentence case name")).toBe("SC")
    expect(getProjectInitials("dotted.name")).toBe("DN")
    expect(getProjectInitials("@scope/package")).toBe("SP")
  })

  test("keeps acronyms and digits whole", () => {
    expect(splitProjectWords("HTTPServer")).toEqual(["HTTP", "Server"])
    expect(splitProjectWords("t3code")).toEqual(["t3code"])
    expect(splitProjectWords("iOSApp2Go")).toEqual(["i", "OS", "App2", "Go"])
    expect(getProjectInitials("API")).toBe("A")
  })

  test("uses the first letter of a single word", () => {
    expect(getProjectInitials("kanna")).toBe("K")
    expect(getProjectInitials("  kanna  ")).toBe("K")
    expect(getProjectInitials("élan")).toBe("É")
  })

  test("falls back to the first character when there are no words", () => {
    expect(getProjectInitials("🚀")).toBe("🚀")
    expect(getProjectInitials("---")).toBe("-")
    expect(getProjectInitials("")).toBe("?")
  })
})

describe("getProjectColor", () => {
  test("is the same for the same name and spread across names", () => {
    expect(getProjectColor("kanna")).toBe(getProjectColor("kanna"))
    const colors = new Set(Array.from({ length: 200 }, (_, index) => getProjectColor(`project-${index}`)))
    expect(colors.size).toBe(16)
  })
})
