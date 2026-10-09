import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  generateRemoteWorkspaceFiles,
  initializeRemoteWorkspace,
  validateAccountName,
  validateAccounts,
  validateDomain,
} from "./remote-workspace-lib"

const temporaryDirectories: string[] = []

async function tempDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kanna-remote-workspace-test-"))
  temporaryDirectories.push(dir)
  return dir
}

async function publicKey(dir: string, name: string) {
  const keyPath = path.join(dir, name)
  const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath], { stdio: "ignore" })
  if (result.status !== 0) throw new Error("ssh-keygen is required for remote-workspace tests")
  return `${keyPath}.pub`
}

async function seedRootOwnedFixture(outputDir: string, publicKeys: Record<string, string>) {
  await mkdir(path.join(outputDir, "config"), { recursive: true, mode: 0o700 })
  await mkdir(path.join(outputDir, "secrets"), { recursive: true, mode: 0o700 })
  await mkdir(path.join(outputDir, "state"), { recursive: true, mode: 0o700 })
  const accounts = [{ name: "alice", sshPort: 2201 }, { name: "bob", sshPort: 2202 }]
  for (const account of accounts) {
    const accountSecrets = path.join(outputDir, "secrets", account.name)
    const accountState = path.join(outputDir, "state", account.name)
    await mkdir(accountSecrets, { recursive: true, mode: 0o700 })
    for (const leaf of ["home", "codex", "workspace", "ssh-home"]) await mkdir(path.join(accountState, leaf), { recursive: true, mode: 0o700 })
    const hostKey = path.join(accountState, "ssh-host-ed25519")
    const result = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey], { stdio: "ignore" })
    if (result.status !== 0) throw new Error("ssh-keygen is required for remote-workspace tests")
    await chmod(hostKey, 0o600)
    await writeFile(path.join(accountSecrets, "authorized_keys"), `${(await readFile(publicKeys[account.name]!, "utf8")).trim().replace(/ [^ ]+$/, "")}\n`, { mode: 0o600 })
    await writeFile(path.join(accountSecrets, "app-password"), "test-only-password\n", { mode: 0o600 })
  }
  await chmod(outputDir, 0o700)
  const runtimeUid = 1000
  const runtimeGid = 1000
  await writeFile(path.join(outputDir, "manifest.json"), `${JSON.stringify({ version: 1, domain: "example.test", local: false, runtimeUid, runtimeGid, accounts }, null, 2)}\n`, { mode: 0o600 })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("remote workspace input validation", () => {
  test("normalizes domains and accepts safe account names", () => {
    expect(validateDomain("Example.COM.")).toBe("example.com")
    expect(validateAccountName("dev-1")).toBe("dev-1")
    expect(() => validateDomain("localhost")).toThrow()
    expect(() => validateAccountName("../root")).toThrow()
  })

  test("rejects duplicate accounts and ports", () => {
    expect(() => validateAccounts([
      { name: "alice", sshPort: 2201 },
      { name: "alice", sshPort: 2202 },
    ])).toThrow("Duplicate account")
    expect(() => validateAccounts([
      { name: "alice", sshPort: 2201 },
      { name: "bob", sshPort: 2201 },
    ])).toThrow("Duplicate SSH port")
    expect(() => validateAccounts([
      { name: "alice", sshPort: 2222, webPort: 8444 },
      { name: "bob", sshPort: 2223, webPort: 8444 },
    ])).toThrow("Duplicate HTTPS port")
    expect(() => validateAccounts([
      { name: "alice", sshPort: 8444, webPort: 8444 },
    ])).toThrow("HTTPS port conflicts with an SSH port")
    expect(() => validateAccounts([
      { name: "alice", sshPort: 2222, webPort: 1023 },
    ])).toThrow("Invalid HTTPS port")
  })
})

describe("remote workspace generation", () => {
  test("initializes and generates localhost deployments while rejecting localhost as a production domain", async () => {
    const root = await tempDir()
    const outputDir = path.join(root, "deployment")
    const key = await publicKey(root, "alice")
    const uid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
    const gid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
    await initializeRemoteWorkspace({
      outputDir,
      domain: "localhost",
      local: true,
      accounts: [{ name: "alice", sshPort: 2201 }],
      runtimeUid: uid,
      runtimeGid: gid,
      publicKeys: { alice: key },
    })
    const generated = await generateRemoteWorkspaceFiles(outputDir)
    expect(generated.manifest.domain).toBe("localhost")
    expect(generated.caddyfile).toContain("alice.localhost")
    expect(generated.compose).toContain('127.0.0.1:8080:80')
    expect(generated.compose).toContain('127.0.0.1:8443:443')
    expect(() => validateDomain("localhost")).toThrow()
  })

  test("requires user public keys and creates private state without a client private key", async () => {
    const root = await tempDir()
    await expect(initializeRemoteWorkspace({
      outputDir: path.join(root, "deployment"),
      domain: "example.test",
      accounts: [{ name: "alice", sshPort: 2201 }],
      runtimeUid: typeof process.getuid === "function" ? process.getuid() : 1000,
      runtimeGid: typeof process.getgid === "function" ? process.getgid() : 1000,
      publicKeys: {},
    })).rejects.toThrow("public key file is required")
    expect(await Bun.file(path.join(root, "deployment", "manifest.json")).exists()).toBe(false)
  })

  test("rejects a root runtime UID and leaves no partial deployment when ownership mapping fails", async () => {
    const root = await tempDir()
    const outputDir = path.join(root, "deployment")
    const key = await publicKey(root, "client")
    const common = {
      domain: "example.test",
      accounts: [{ name: "alice", sshPort: 2201 }],
      publicKeys: { alice: key },
    }
    await expect(initializeRemoteWorkspace({
      ...common,
      outputDir,
      runtimeUid: 0,
      runtimeGid: 1000,
    })).rejects.toThrow("non-root positive integers")
    expect(await Bun.file(path.join(outputDir, "manifest.json")).exists()).toBe(false)

    if (typeof process.getuid === "function" && process.getuid() === 0) {
      try {
        await initializeRemoteWorkspace({ ...common, outputDir, runtimeUid: 1000, runtimeGid: 1000 })
        expect(await Bun.file(path.join(outputDir, "manifest.json")).exists()).toBe(true)
      } catch (error) {
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toContain("Cannot prepare persistent state")
        expect(await Bun.file(path.join(outputDir, "manifest.json")).exists()).toBe(false)
        expect((await readdir(root)).some((name) => name.startsWith("deployment.init-"))).toBe(false)
      }
    }
  })

  test("generates isolated services, account config, known_hosts and safe file modes", async () => {
    const root = await tempDir()
    const outputDir = path.join(root, "deployment")
    const aliceKey = await publicKey(root, "alice")
    const bobKey = await publicKey(root, "bob")
    const uid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
    const gid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
    const publicKeys = { alice: aliceKey, bob: bobKey }
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      await seedRootOwnedFixture(outputDir, publicKeys)
    } else {
      await initializeRemoteWorkspace({
        outputDir,
        domain: "example.test",
        accounts: [{ name: "alice", sshPort: 2201 }, { name: "bob", sshPort: 2202 }],
        runtimeUid: uid,
        runtimeGid: gid,
        publicKeys,
      })
    }
    const generated = await generateRemoteWorkspaceFiles(outputDir)
    expect(generated.compose).toContain("account_alice")
    expect(generated.compose).toContain("account_bob")
    expect(generated.compose).toContain("workspace:/workspace")
    expect(generated.compose).toContain("DAC_READ_SEARCH")
    expect(generated.compose).toContain("    init: true")
    expect(generated.compose).toContain('command: ["--host", "0.0.0.0", "--no-open", "--password-file", "/run/secrets/kanna_password", "--trust-proxy"]')
    expect(generated.compose).not.toContain('command: ["bun", "./bin/kanna"')
    const dockerfile = await readFile(new URL("../deploy/remote-workspace/Dockerfile.app", import.meta.url), "utf8")
    expect(dockerfile).toContain('ENTRYPOINT ["bun", "./bin/kanna"]')
    expect(dockerfile).toContain("ENV PATH=/app/bin:/opt/bun/bin:")
    expect(dockerfile).toContain("passwd")
    expect(dockerfile).not.toContain("util-linux")
    expect(dockerfile).toContain('test "$(command -v kanna)" = /app/bin/kanna')
    expect(generated.caddyfile).toContain("alice.example.test")
    expect(generated.caddyfile).toContain("bob.example.test")
    expect(generated.hostKeyByAccount.get("alice")).toMatch(/^ssh-ed25519 /)
    const appConfig = JSON.parse(await readFile(path.join(outputDir, "config/alice.json"), "utf8")) as Record<string, unknown>
    expect(appConfig).toMatchObject({
      displayName: "alice",
      sshHost: "alice.example.test",
      sshPort: 2201,
      sshUser: "workspace",
      workspaceRoot: "/workspace",
    })
    expect(await readFile(path.join(outputDir, "config/alice.known_hosts"), "utf8")).toContain("[alice.example.test]:2201 ssh-ed25519")
    expect(await readFile(path.join(outputDir, "secrets/alice/authorized_keys"), "utf8")).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=*\n$/)
    expect(await stat(path.join(outputDir, "manifest.json")).then((value) => value.mode & 0o077)).toBe(0)
    expect(await stat(path.join(outputDir, "secrets/alice/app-password")).then((value) => value.mode & 0o077)).toBe(0)
    expect(await stat(path.join(outputDir, "state/alice/ssh-host-ed25519")).then((value) => value.mode & 0o077)).toBe(0)
    expect(await stat(path.join(outputDir, "sync.sh")).then((value) => value.mode & 0o777)).toBe(0o755)
    expect(await Bun.file(path.join(outputDir, "secrets/alice/client-ed25519")).exists()).toBe(false)
  })

  test("generates shared-hostname HTTPS ports with external TLS mounted only into Caddy", async () => {
    const root = await tempDir()
    const outputDir = path.join(root, "deployment")
    const aliceKey = await publicKey(root, "elim")
    const bobKey = await publicKey(root, "zzx")
    const certFile = path.join(root, "fullchain.pem")
    const keyFile = path.join(root, "privkey.pem")
    await writeFile(certFile, "test certificate\n", { mode: 0o644 })
    await writeFile(keyFile, "test private key\n", { mode: 0o600 })
    const uid = typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000
    const gid = typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000
    await initializeRemoteWorkspace({
      outputDir,
      domain: "fnos.example.test",
      publicHostname: "fnos.example.test",
      hostnameMode: "shared",
      tls: { mode: "external", certFile, keyFile },
      accounts: [
        { name: "elim", sshPort: 2222, webPort: 8444 },
        { name: "zzx", sshPort: 2223, webPort: 8445 },
      ],
      runtimeUid: uid,
      runtimeGid: gid,
      publicKeys: { elim: aliceKey, zzx: bobKey },
    })

    const generated = await generateRemoteWorkspaceFiles(outputDir)
    expect(generated.manifest).toMatchObject({
      hostnameMode: "shared",
      publicHostname: "fnos.example.test",
      tls: { mode: "external", certFile, keyFile },
    })
    expect(generated.caddyfile).toContain("fnos.example.test:8444 {")
    expect(generated.caddyfile).toContain("fnos.example.test:8445 {")
    expect(generated.caddyfile).toContain("reverse_proxy http://kanna_elim:3210")
    expect(generated.caddyfile).toContain("reverse_proxy http://kanna_zzx:3210")
    expect(generated.caddyfile.match(/header_up -Cookie/g)).toHaveLength(2)
    expect(generated.caddyfile.match(/header_down -Set-Cookie/g)).toHaveLength(2)
    expect(generated.compose).toContain('"8444:8444"')
    expect(generated.compose).toContain('"8445:8445"')
    expect(generated.compose).not.toContain('"80:80"')
    expect(generated.compose).not.toContain('"443:443"')
    expect(generated.compose).not.toContain('"127.0.0.1:8443:443"')
    expect(generated.compose).toContain(`source: ${JSON.stringify(await realpath(certFile))}`)
    expect(generated.compose).toContain(`source: ${JSON.stringify(await realpath(keyFile))}`)
    expect(generated.compose).toContain("target: /run/caddy/external-cert.pem\n        read_only: true")
    expect(generated.compose).toContain("target: /run/caddy/external-key.pem\n        read_only: true")
    const aliceConfig = JSON.parse(await readFile(path.join(outputDir, "config/elim.json"), "utf8")) as Record<string, unknown>
    expect(aliceConfig).toMatchObject({
      authMode: "bearer",
      sshHost: "fnos.example.test",
      sshPort: 2222,
      webHost: "fnos.example.test",
      webPort: 8444,
      webOrigin: "https://fnos.example.test:8444",
    })
    expect(await readFile(path.join(outputDir, "config/elim.known_hosts"), "utf8"))
      .toContain("[fnos.example.test]:2222 ssh-ed25519")
    expect(await stat(path.join(outputDir, "manifest.json")).then((value) => value.mode & 0o077)).toBe(0)
  })

  test("internal shared TLS is explicit, persistent in Caddy data and never mounted into app or SSH", async () => {
    const root = await tempDir()
    const outputDir = path.join(root, "deployment")
    const elimKey = await publicKey(root, "elim")
    const zzxKey = await publicKey(root, "zzx")
    await initializeRemoteWorkspace({
      outputDir,
      domain: "fnos.example.test",
      publicHostname: "fnos.example.test",
      hostnameMode: "shared",
      tls: { mode: "internal" },
      accounts: [
        { name: "elim", sshPort: 2222, webPort: 18444 },
        { name: "zzx", sshPort: 2223, webPort: 18445 },
      ],
      runtimeUid: typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000,
      runtimeGid: typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000,
      publicKeys: { elim: elimKey, zzx: zzxKey },
    })
    const generated = await generateRemoteWorkspaceFiles(outputDir)
    expect(generated.manifest).toMatchObject({ hostnameMode: "shared", tls: { mode: "internal" } })
    expect(generated.caddyfile.match(/tls internal/g)).toHaveLength(2)
    expect(generated.caddyfile).toContain("fnos.example.test:18444 {")
    expect(generated.caddyfile).toContain("fnos.example.test:18445 {")
    expect(generated.compose).toContain("caddy_data:/data")
    expect(generated.compose).not.toContain("external-cert.pem")
    expect(generated.compose).not.toContain("external-key.pem")
    expect(generated.compose).not.toContain('"80:80"')
    expect(generated.compose).not.toContain('"443:443"')
    expect(generated.compose.match(/caddy_data:\/data/g)).toHaveLength(1)
  })

  test("rejects shared-hostname TLS paths unless the key is absolute, private and readable", async () => {
    const root = await tempDir()
    const key = await publicKey(root, "elim")
    const certFile = path.join(root, "fullchain.pem")
    const keyFile = path.join(root, "privkey.pem")
    await writeFile(certFile, "test certificate\n", { mode: 0o644 })
    await writeFile(keyFile, "test private key\n", { mode: 0o644 })
    const common = {
      domain: "fnos.example.test",
      publicHostname: "fnos.example.test",
      hostnameMode: "shared" as const,
      accounts: [{ name: "elim", sshPort: 2222, webPort: 8444 }],
      runtimeUid: typeof process.getuid === "function" && process.getuid() > 0 ? process.getuid() : 1000,
      runtimeGid: typeof process.getgid === "function" && process.getgid() > 0 ? process.getgid() : 1000,
      publicKeys: { elim: key },
    }
    await expect(initializeRemoteWorkspace({
      ...common,
      outputDir: path.join(root, "too-open"),
      tls: { mode: "external", certFile, keyFile },
    })).rejects.toThrow("TLS private key must be owner-readable and not readable or writable by group or others")
    expect(await Bun.file(path.join(root, "too-open", "manifest.json")).exists()).toBe(false)
    await chmod(keyFile, 0o600)
    await expect(initializeRemoteWorkspace({
      ...common,
      outputDir: path.join(root, "relative"),
      tls: { mode: "external", certFile, keyFile: "relative-key.pem" },
    })).rejects.toThrow("TLS private key path must be an absolute file path")
    expect(await Bun.file(path.join(root, "relative", "manifest.json")).exists()).toBe(false)
  })
})
