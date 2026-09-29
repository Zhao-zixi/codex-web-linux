/**
 * Installs the package the way a user gets it and checks that it runs,
 * before publish.yml sends it to npm. The server ships as a bundle
 * (scripts/build-server.ts), and a bundle can build fine yet fail at
 * runtime: a dependency that reads its own files, or imports by a computed
 * name. So: pack, install the tarball into an empty folder, and start it
 * with a throwaway home, so no real ~/.kanna is touched.
 *
 * Run after `bun run build`.
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.resolve(import.meta.dir, "..")
const work = mkdtempSync(path.join(tmpdir(), "kanna-smoke-"))
const home = path.join(work, "home")

function run(cmd: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = Bun.spawnSync(cmd, { cwd: options.cwd ?? work, env: { ...process.env, ...options.env }, stdout: "pipe", stderr: "pipe" })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  if (result.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${result.exitCode}):\n${output}`)
  return output.trim()
}

let server: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null
try {
  run(["bun", "pm", "pack", "--destination", work], { cwd: ROOT })
  const tarball = readdirSync(work).find((file) => file.endsWith(".tgz"))
  if (!tarball) throw new Error("bun pm pack produced no tarball")

  writeFileSync(path.join(work, "package.json"), JSON.stringify({ name: "kanna-smoke", private: true }))
  run(["bun", "add", path.join(work, tarball)])
  const bin = path.join(work, "node_modules", ".bin", "kanna")

  const env = {
    HOME: home,
    KANNA_DISABLE_SELF_UPDATE: "1",
    // The supervisor starts its child through `kanna` on PATH, which on a
    // developer's machine is their real install. Point it at this one.
    KANNA_CLI_CHILD_COMMAND: bin,
  }
  const expected = (await Bun.file(path.join(ROOT, "package.json")).json() as { version: string }).version
  const version = run([bin, "--version"], { env })
  if (!version.includes(expected)) throw new Error(`kanna --version printed "${version}", expected ${expected}`)
  console.log(`smoke: installed ${tarball}, --version ${expected}`)

  const port = 41000 + Math.floor(Math.random() * 1000)
  server = Bun.spawn([bin, "--no-open", "--no-cloud", "--strict-port", "--port", String(port)], {
    cwd: work,
    stdin: "ignore",
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })

  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  let healthy = false
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/health`).catch(() => null)
    if (response?.ok) {
      healthy = true
      break
    }
    if (server.exitCode !== null) break
    await Bun.sleep(250)
  }
  if (!healthy) {
    server.kill()
    const logs = `${await new Response(server.stdout).text()}${await new Response(server.stderr).text()}`
    throw new Error(`the server never answered /health:\n${logs.slice(-4000)}`)
  }

  // The prebuilt client ships beside the bundle; the server has to find it.
  const page = await fetch(base).then((response) => response.text())
  if (!page.includes("<div id=\"root\"")) throw new Error("GET / didn't serve the client")
  console.log("smoke: /health answered and / served the client")
} finally {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await Promise.race([server.exited, Bun.sleep(5000)])
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  rmSync(work, { recursive: true, force: true })
}
