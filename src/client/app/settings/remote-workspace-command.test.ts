import { describe, expect, test } from "bun:test"
import {
  buildKnownHostsEntry,
  buildMutagenCreateCommand,
  buildSshConfigSnippet,
  hostedSshAlias,
  isValidLocalPath,
  isValidPrivateKeyPath,
  isValidProjectName,
  shellQuotePosix,
} from "./remote-workspace-command"

describe("remote workspace shell commands", () => {
  test("quotes spaces, apostrophes, shell syntax, and Unicode paths", () => {
    expect(shellQuotePosix("/tmp/项目 it's; $(touch nope)"))
      .toBe("'/tmp/项目 it'\\''s; $(touch nope)'")
  })

  test("builds an escaped SCP-style Mutagen endpoint", () => {
    expect(buildMutagenCreateCommand({
      localPath: "/Users/我 名字/project's",
      projectName: "项目 name",
      sshUser: "kanna",
      sshHost: "sync.example.test",
      sshPort: 2222,
      workspaceRoot: "/workspace",
    })).toBe("mutagen sync create --name 'kanna-sync-example-test-10cf48a973a9dbf0-2222-name-02d7e36356ba6f69' --sync-mode=two-way-safe --ignore-vcs --ignore '.git' --ignore '.kanna' --ignore '.remote-workspace' --ignore '.ssh' --ignore '.codex/auth.json' --ignore '.aws/credentials' --ignore 'node_modules' --ignore 'vendor' --ignore '.venv' --ignore 'venv' --ignore 'target' --ignore 'dist' --ignore 'build' --ignore '.next' --ignore '.turbo' --ignore '.cache' --ignore '.pytest_cache' --ignore '__pycache__' --ignore '.env' --ignore '.env.*' --ignore 'secrets' --ignore '*.pem' --ignore '*.key' '/Users/我 名字/project'\\''s' 'kanna@kanna-sync-example-test-10cf48a973a9dbf0-2222:/workspace/项目 name'")
  })

  test("pins the deployment public key in an account-specific known_hosts entry and SSH alias", () => {
    const key = "ssh-ed25519 AQIDBAUGBwg="
    expect(buildKnownHostsEntry({ sshHost: "sync.example.test", sshPort: 2222, publicHostKey: key }))
      .toBe("[sync.example.test]:2222 ssh-ed25519 AQIDBAUGBwg=")
    expect(buildKnownHostsEntry({ sshHost: "sync.example.test", sshPort: 22, publicHostKey: key }))
      .toBe("sync.example.test ssh-ed25519 AQIDBAUGBwg=")
    const config = buildSshConfigSnippet({
      sshHost: "sync.example.test",
      sshPort: 2222,
      sshUser: "kanna user",
      publicHostKey: key,
      privateKeyPath: '/Users/me/keys/id "one"',
    })
    expect(config.alias).toBe(hostedSshAlias("sync.example.test", 2222))
    expect(config.knownHostsPath).toBe(`~/.ssh/${hostedSshAlias("sync.example.test", 2222)}_known_hosts`)
    expect(config.text).toContain("  StrictHostKeyChecking yes")
    expect(config.text).toContain("  IdentitiesOnly yes")
    expect(config.text).toContain('IdentityFile "/Users/me/keys/id \\\"one\\\""')
    expect(config.text).toContain("User \"kanna user\"")
  })

  test("accepts one path segment including Unicode and spaces while rejecting traversal and controls", () => {
    expect(isValidProjectName("项目 name")).toBe(true)
    expect(isValidProjectName(".")).toBe(false)
    expect(isValidProjectName("..")).toBe(false)
    expect(isValidProjectName("a/b")).toBe(false)
    expect(isValidProjectName("a:b")).toBe(false)
    expect(isValidProjectName("bad\nname")).toBe(false)
    expect(isValidPrivateKeyPath("/Users/名字/my key")).toBe(true)
    expect(isValidPrivateKeyPath("~/.ssh/id_ed25519")).toBe(true)
    expect(isValidPrivateKeyPath("relative/key")).toBe(false)
    expect(isValidPrivateKeyPath("~/.ssh/key\nHost *")).toBe(false)
    expect(isValidLocalPath("/Users/名字/my project ")).toBe(true)
    expect(isValidLocalPath("relative/project")).toBe(false)
    expect(isValidLocalPath("/bad\npath")).toBe(false)
  })
})
