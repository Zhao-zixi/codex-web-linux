import { describe, expect, test } from "bun:test"
import { statSync } from "node:fs"
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createAdminProviderControl, createNativeProviderTokenSingleflight } from "./gateway-provider-control"
import type { ProviderAuthManagerDeps, StreamingChild } from "./provider-auth"

function fakeAuthDeps(homeDir: string, options: { onLoginStart?: () => void } = {}) {
  const observations: string[] = []
  const deps: Pick<ProviderAuthManagerDeps, "exec" | "spawnStreaming" | "spawnPty"> = {
    async exec(argv, opts) {
      observations.push(`${argv.join(" ")}:${opts?.env?.HOME}:${opts?.env?.CODEX_HOME}:${opts?.env?.CLAUDE_CONFIG_DIR}`)
      for (const directory of [homeDir, path.join(homeDir, ".codex"), path.join(homeDir, ".claude")]) {
        const info = await stat(directory).catch(() => null)
        if (!info?.isDirectory()) throw new Error("Admin CLI profile directory is missing during probe")
      }
      if (argv[0] === "/fake/codex" && argv[1] === "--version") return { code: 0, stdout: "codex-cli 0.161.0", stderr: "" }
      if (argv[0] === "/fake/codex" && argv[1] === "login") return { code: 1, stdout: "", stderr: "not logged in" }
      return { code: 0, stdout: "", stderr: "" }
    },
    spawnStreaming(argv) {
      if (argv[0] !== "/fake/codex" || argv[1] !== "login" || argv[2] !== "--device-auth") {
        throw new Error("Unexpected provider login command")
      }
      for (const directory of [homeDir, path.join(homeDir, ".codex"), path.join(homeDir, ".claude")]) {
        if (!statSync(directory).isDirectory()) throw new Error("Admin CLI profile directory is missing during login")
      }
      options.onLoginStart?.()
      let finish!: (code: number) => void
      const exited = new Promise<number>((resolve) => { finish = resolve })
      const child: StreamingChild = {
        onOutput() {},
        exited,
        kill: () => finish(1),
      }
      return child
    },
    spawnPty() { throw new Error("Unexpected PTY") },
  }
  return { deps, observations }
}

describe("admin native token request boundary", () => {
  test("coalesces identical requests before they enter the provider lock", async () => {
    const singleflight = createNativeProviderTokenSingleflight<string>()
    let calls = 0
    const action = async () => {
      calls += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return "short-access"
    }
    const [first, second] = await Promise.all([
      singleflight("codex", {}, action),
      singleflight("codex", {}, action),
    ])
    expect(calls).toBe(1)
    expect(first).toBe("short-access")
    expect(second).toBe(first)
  })

  test("does not coalesce a forced refresh or a different pinned account", async () => {
    const singleflight = createNativeProviderTokenSingleflight<string>()
    const calls: string[] = []
    const action = (label: string) => async () => {
      calls.push(label)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return label
    }
    const values = await Promise.all([
      singleflight("codex", { previousAccountId: "acct-1" }, action("normal")),
      singleflight("codex", { forceRefresh: true, previousAccountId: "acct-1" }, action("refresh")),
      singleflight("codex", { previousAccountId: "acct-2" }, action("other-account")),
    ])
    expect(calls).toHaveLength(3)
    expect(values).toEqual(["normal", "refresh", "other-account"])
  })
})

describe("admin CLI profile initialization", () => {
  test("creates missing profile dirs before status probes and starts device auth from an empty home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-admin-home-test-"))
    const homeDir = path.join(root, "admin-home")
    const ordinaryHomeDir = path.join(root, "ordinary-user")
    let loginStarted = false
    const { deps, observations } = fakeAuthDeps(homeDir, { onLoginStart: () => { loginStarted = true } })
    const control = createAdminProviderControl({
      homeDir,
      createAuthDeps: () => deps,
      resolveCommandPath: (command) => command === "codex" ? "/fake/codex" : null,
    })

    try {
      expect((await control.getStatuses()).find((item) => item.id === "codex")).toMatchObject({ installed: true, authStatus: "signed_out" })
      expect(observations.length).toBeGreaterThan(0)
      expect(observations.every((value) => value.endsWith(`${homeDir}:${path.join(homeDir, ".codex")}:${path.join(homeDir, ".claude")}`))).toBe(true)
      expect((await stat(path.join(homeDir, ".codex"))).mode & 0o777).toBe(0o700)
      expect((await stat(path.join(homeDir, ".claude"))).mode & 0o777).toBe(0o700)

      await control.start("codex")
      expect(loginStarted).toBe(true)
      await control.cancel("codex")
      expect((await control.getStatuses()).find((item) => item.id === "codex")?.flow.phase).toBe("idle")
      expect(await Bun.file(path.join(ordinaryHomeDir, ".codex")).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("preserves existing profile contents and directory permissions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-admin-home-existing-test-"))
    const homeDir = path.join(root, "admin-home")
    const codexDir = path.join(homeDir, ".codex")
    const claudeDir = path.join(homeDir, ".claude")
    await mkdir(codexDir, { recursive: true, mode: 0o751 })
    await mkdir(claudeDir, { recursive: true, mode: 0o771 })
    await chmod(codexDir, 0o751)
    await chmod(claudeDir, 0o771)
    await writeFile(path.join(codexDir, "config.toml"), "test_config = true\n", { mode: 0o640 })
    const { deps } = fakeAuthDeps(homeDir)
    const control = createAdminProviderControl({
      homeDir,
      createAuthDeps: () => deps,
      resolveCommandPath: (command) => command === "codex" ? "/fake/codex" : null,
    })

    try {
      await control.getStatuses()
      expect(await readFile(path.join(codexDir, "config.toml"), "utf8")).toBe("test_config = true\n")
      expect((await stat(codexDir)).mode & 0o777).toBe(0o751)
      expect((await stat(claudeDir)).mode & 0o777).toBe(0o771)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
