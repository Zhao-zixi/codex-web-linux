import { builtinModules } from "node:module"

/**
 * Reads the emitted server bundle (scripts/build-server.ts) and reports what
 * would break at runtime even though the build succeeded. The bundler config
 * says what should happen; this checks what did.
 *
 * - A package meant to stay external was inlined anyway: it then looks for
 *   its own files, or its native addon, beside the bundle.
 * - A path from the build machine is baked in: a package located itself
 *   while bundling (photon-node did, via __dirname) and will look there on
 *   every user's machine.
 * - The bundle loads a package that won't be installed: every bare import
 *   left in it must be a builtin, a declared dependency, or a known optional
 *   one that its caller guards. Looking a package up on disk counts too
 *   (`import.meta.resolve`, `require.resolve`): a bundled package has no
 *   folder to find. Kanna read the Agent SDK's package.json that way, and
 *   0.76.1 failed on the first Claude version check.
 * - Nothing was seen at all: Bun's `// node_modules/…` region comments are how
 *   this sees inlined packages. If their format changed, an empty scan would
 *   pass silently, so a bundle with no regions is a failure too.
 */

export interface BundleFile {
  path: string
  text: string
}

export interface BundleCheckOptions {
  /** Package-name prefixes that must never be inlined (build-server EXTERNAL). */
  external: string[]
  /** package.json `dependencies`: what a user's install will have. */
  dependencies: string[]
  /** Loaded only behind a guard (try/catch, platform check); fine to be missing. */
  optional: string[]
  /** Absolute paths that must not appear in the output (the repo root). */
  forbiddenPaths: string[]
}

export interface BundleCheckResult {
  problems: string[]
  inlinedPackages: string[]
  regionCount: number
}

const BUILTINS = new Set([...builtinModules, "bun", "ws"])

/**
 * What a module specifier looks like. Bundled parsers (acorn, inside jiti)
 * hold source text with `import(` and `from "` in it; anything shaped
 * otherwise is text, not a load.
 */
const SPECIFIER = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w.@-]+)*$/i

function packageName(specifier: string) {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!
}

function isBuiltin(specifier: string) {
  return specifier.startsWith("node:") || specifier.startsWith("bun:") || BUILTINS.has(specifier) || BUILTINS.has(packageName(specifier))
}

function matchesPrefix(name: string, prefixes: string[]) {
  return prefixes.some((prefix) => prefix.endsWith("*") ? name.startsWith(prefix.slice(0, -1)) : name === prefix)
}

export function checkServerBundle(files: BundleFile[], options: BundleCheckOptions): BundleCheckResult {
  const problems: string[] = []
  const inlined = new Set<string>()
  let regionCount = 0

  for (const file of files) {
    for (const region of file.text.matchAll(/^\/\/ (node_modules\/\S+|src\/\S+)/gm)) {
      regionCount += 1
      const nested = [...region[1]!.matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)\//g)]
      const name = nested.at(-1)?.[1]
      if (name) inlined.add(name)
    }

    for (const forbidden of options.forbiddenPaths) {
      if (file.text.includes(forbidden)) {
        problems.push(`${file.path} contains the build machine's path ${forbidden}: something located itself while bundling`)
      }
    }

    // Real module loads only: import declarations, re-exports, import(),
    // and Bun's __require shim. Plain require("…") text also shows up inside
    // code that generates code (ajv), so it isn't counted.
    const specifiers = new Set<string>()
    for (const match of file.text.matchAll(/(?:^|[\s;}])(?:import|export)\b[^"'`;]*?\bfrom\s*"([^"]+)"/g)) specifiers.add(match[1]!)
    for (const match of file.text.matchAll(/(?:^|[\s;])import\s*"([^"]+)"/g)) specifiers.add(match[1]!)
    for (const match of file.text.matchAll(/\bimport\(\s*"([^"]+)"\s*\)/g)) specifiers.add(match[1]!)
    for (const match of file.text.matchAll(/\b__require\(\s*"([^"]+)"\s*\)/g)) specifiers.add(match[1]!)
    for (const match of file.text.matchAll(/\b(?:import\.meta|require)\.resolve\(\s*"([^"]+)"/g)) specifiers.add(match[1]!)
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) continue
      if (!SPECIFIER.test(specifier)) continue
      const name = packageName(specifier)
      if (options.dependencies.includes(name) || matchesPrefix(name, options.optional)) continue
      problems.push(`${file.path} loads "${specifier}" at runtime, but ${name} isn't a dependency, so users won't have it`)
    }
  }

  for (const name of inlined) {
    if (matchesPrefix(name, options.external)) problems.push(`${name} was bundled, but it has to stay external (build-server.ts EXTERNAL)`)
  }
  if (regionCount === 0) {
    problems.push("no `// node_modules/…` or `// src/…` region comments found: the bundler's format changed, and this check can no longer see what it bundled")
  }

  return { problems, inlinedPackages: [...inlined].sort(), regionCount }
}
