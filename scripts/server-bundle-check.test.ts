import { describe, expect, test } from "bun:test"
import { checkServerBundle, type BundleCheckOptions } from "./server-bundle-check"

const OPTIONS: BundleCheckOptions = {
  external: ["cloudflared", "@mariozechner/*"],
  dependencies: ["cloudflared", "@mariozechner/pi-ai"],
  optional: ["koffi"],
  forbiddenPaths: ["/Users/builder/kanna"],
}

const CLEAN = `// src/server/cli.ts
import { readFileSync } from "node:fs"
import * as path from "path"
import {
  complete,
  stream
} from "@mariozechner/pi-ai";
import { Tunnel } from "cloudflared"

// node_modules/zod/v4/core.js
var z = 1;
const load = async () => { try { return await import("koffi") } catch { return null } }
const fs = __require("fs");
// ajv writes code as text, which isn't a load:
const code = 'require("ajv/dist/runtime/equal")';
// nor is a bundled parser's source text:
if (t) return i2.name = " + ", this.parseDynamicImport(t3), import(", 6: l + ");
`

describe("checkServerBundle", () => {
  test("a clean bundle passes, and reports what it inlined", () => {
    const result = checkServerBundle([{ path: "cli.js", text: CLEAN }], OPTIONS)
    expect(result.problems).toEqual([])
    expect(result.inlinedPackages).toEqual(["zod"])
    expect(result.regionCount).toBe(2)
  })

  test("an external package that got inlined fails", () => {
    const text = `${CLEAN}\n// node_modules/@mariozechner/pi-coding-agent/dist/config.js\nvar x = 1;\n`
    const { problems } = checkServerBundle([{ path: "chunk.js", text }], OPTIONS)
    expect(problems).toEqual([expect.stringContaining("@mariozechner/pi-coding-agent was bundled")])
  })

  test("a nested node_modules path counts as the innermost package", () => {
    const text = `${CLEAN}\n// node_modules/foo/node_modules/cloudflared/lib/index.js\nvar x = 1;\n`
    const { problems } = checkServerBundle([{ path: "chunk.js", text }], OPTIONS)
    expect(problems).toEqual([expect.stringContaining("cloudflared was bundled")])
  })

  test("a baked-in build-machine path fails", () => {
    const text = `${CLEAN}\nvar __dirname = "/Users/builder/kanna/node_modules/@silvia-odwyer/photon-node";\n`
    const { problems } = checkServerBundle([{ path: "chunk.js", text }], OPTIONS)
    expect(problems).toEqual([expect.stringContaining("contains the build machine's path")])
  })

  test("a runtime import of a package users won't have fails", () => {
    const text = `${CLEAN}\nimport { thing } from "left-pad/sub";\nconst x = await import("@scope/missing");\n`
    const { problems } = checkServerBundle([{ path: "chunk.js", text }], OPTIONS)
    expect(problems).toEqual([
      expect.stringContaining('loads "left-pad/sub"'),
      expect.stringContaining('loads "@scope/missing"'),
    ])
  })

  test("looking a bundled package up on disk fails: it has no folder there", () => {
    const text = `${CLEAN}\nconst entry = fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));\nconst p = require.resolve("zod/package.json");\n`
    const { problems } = checkServerBundle([{ path: "chunk.js", text }], OPTIONS)
    expect(problems).toEqual([
      expect.stringContaining('loads "@anthropic-ai/claude-agent-sdk"'),
      expect.stringContaining('loads "zod/package.json"'),
    ])
  })

  test("a bundle with no region comments fails rather than passing blind", () => {
    const { problems } = checkServerBundle([{ path: "cli.js", text: "var x = 1;\n" }], OPTIONS)
    expect(problems).toEqual([expect.stringContaining("no `// node_modules/…`")])
  })
})
