import { describe, expect, test } from "bun:test"
import { parseHostedWorkspaceConfig, readHostedWorkspaceConfig } from "./hosted-workspace"

const testPublicHostKey = `ssh-ed25519 ${Buffer.concat([
  Buffer.from([0, 0, 0, 11]),
  Buffer.from("ssh-ed25519"),
  Buffer.from([0, 0, 0, 32]),
  Buffer.alloc(32, 7),
]).toString("base64")}`

describe("hosted workspace configuration", () => {
  test("is disabled without a configured file and fails without leaking its path when unreadable", async () => {
    expect(await readHostedWorkspaceConfig()).toEqual({ enabled: false })
    const missingPath = "/private/deploy/secret-config.json"
    await expect(readHostedWorkspaceConfig(missingPath)).rejects.toThrow("Hosted workspace configuration is invalid or unreadable")
    await expect(readHostedWorkspaceConfig(missingPath)).rejects.not.toThrow(missingPath)
  })

  test("returns only the public SSH connection fields", () => {
    expect(parseHostedWorkspaceConfig({
      displayName: "专属工作区",
      sshHost: "sync.example.test",
      sshPort: 2222,
      sshUser: "kanna_sync",
      workspaceRoot: "/workspace",
      publicHostKey: testPublicHostKey,
      password: "must-not-leak",
      privateKey: "must-not-leak",
      hostPath: "/srv/private",
    })).toEqual({
      displayName: "专属工作区",
      sshHost: "sync.example.test",
      sshPort: 2222,
      sshUser: "kanna_sync",
      workspaceRoot: "/workspace",
      publicHostKey: testPublicHostKey,
    })
  })

  test("accepts only a complete HTTPS bearer origin and returns its metadata", () => {
    const config = parseHostedWorkspaceConfig({
      displayName: "elim",
      sshHost: "fnos.zixizhao.top",
      sshPort: 2222,
      sshUser: "workspace",
      workspaceRoot: "/workspace",
      authMode: "bearer",
      webHost: "fnos.zixizhao.top",
      webPort: 8444,
      webOrigin: "https://fnos.zixizhao.top:8444",
      publicHostKey: testPublicHostKey,
    })
    expect(config).toMatchObject({
      authMode: "bearer",
      webHost: "fnos.zixizhao.top",
      webPort: 8444,
      webOrigin: "https://fnos.zixizhao.top:8444",
    })
    const { authMode: _authMode, webHost: _webHost, webPort: _webPort, webOrigin: _webOrigin, ...legacy } = config
    expect(legacy).toMatchObject({ displayName: "elim", sshHost: "fnos.zixizhao.top", sshPort: 2222 })
    expect(() => parseHostedWorkspaceConfig({
      displayName: "elim",
      sshHost: "fnos.zixizhao.top",
      sshPort: 2222,
      sshUser: "workspace",
      workspaceRoot: "/workspace",
      authMode: "bearer",
      webHost: "fnos.zixizhao.top",
      webPort: 8444,
      webOrigin: "https://fnos.zixizhao.top:8445",
    })).toThrow("Invalid hosted workspace webOrigin")
  })

  test("rejects invalid host, port, user, and paths outside /workspace", () => {
    const base = { displayName: "workspace", sshHost: "sync.example.test", sshPort: 22, sshUser: "kanna", workspaceRoot: "/workspace" }
    expect(parseHostedWorkspaceConfig({ ...base, sshUser: "runner" }).sshUser).toBe("runner")
    expect(parseHostedWorkspaceConfig({ ...base, sshUser: "alice0" }).sshUser).toBe("alice0")
    expect(() => parseHostedWorkspaceConfig({ ...base, displayName: "bad\nname" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, displayName: "bad\rname" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, displayName: "bad\0name" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshHost: "host;touch /tmp/pwned" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshHost: "2001:db8::1" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshHost: "[2001:db8::1]" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshPort: 65536 })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshUser: "user@host" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, sshHost: "bad;host" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, workspaceRoot: "/workspace/../etc" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, workspaceRoot: "/workspace-old" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, publicHostKey: "-----BEGIN OPENSSH PRIVATE KEY-----" })).toThrow()
    expect(() => parseHostedWorkspaceConfig({ ...base, publicHostKey: `ssh-ed25519 ${Buffer.from("ssh-ed25519").toString("base64")}` })).toThrow()
  })
})
