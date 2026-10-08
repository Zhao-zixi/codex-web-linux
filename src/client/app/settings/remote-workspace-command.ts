/** Quote one argument for POSIX shells (sh, bash, zsh). */
export function shellQuotePosix(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function sshConfigQuote(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

export function isSafeSshConfigValue(value: string) {
  return !/[\x00-\x1f\x7f]/.test(value)
}

export function isValidPrivateKeyPath(value: string) {
  return (value.startsWith("/") || value.startsWith("~/")) && isSafeSshConfigValue(value)
}

export function isValidLocalPath(value: string) {
  return value.startsWith("/") && isSafeSshConfigValue(value)
}

function stableHash(value: string) {
  let hash = 14695981039346656037n
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = BigInt.asUintN(64, hash * 1099511628211n)
  }
  return hash.toString(16).padStart(16, "0")
}

export function hostedSshAlias(host: string, port: number) {
  const hostSlug = (host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "host").slice(0, 24)
  return `kanna-${hostSlug}-${stableHash(host)}-${port}`
}

export function isValidProjectName(value: string) {
  return value.length > 0 && value !== "." && value !== ".." && !/[/:\\\x00-\x1f\x7f]/.test(value)
}

export function buildKnownHostsEntry(args: { sshHost: string; sshPort: number; publicHostKey: string }) {
  const host = args.sshPort === 22 ? args.sshHost : `[${args.sshHost}]:${args.sshPort}`
  return `${host} ${args.publicHostKey}`
}

export function buildSshConfigSnippet(args: {
  sshHost: string
  sshPort: number
  sshUser: string
  publicHostKey: string
  privateKeyPath: string
}) {
  if (!isValidPrivateKeyPath(args.privateKeyPath)) throw new Error("SSH key path must be an absolute path without control characters")
  const alias = hostedSshAlias(args.sshHost, args.sshPort)
  const knownHostsPath = `~/.ssh/${alias}_known_hosts`
  return {
    alias,
    knownHostsPath,
    text: [
      `Host ${alias}`,
      `  HostName ${sshConfigQuote(args.sshHost)}`,
      `  Port ${args.sshPort}`,
      `  User ${sshConfigQuote(args.sshUser)}`,
      `  UserKnownHostsFile ${sshConfigQuote(knownHostsPath)}`,
      "  StrictHostKeyChecking yes",
      "  IdentitiesOnly yes",
      `  IdentityFile ${sshConfigQuote(args.privateKeyPath)}`,
    ].join("\n"),
    knownHosts: buildKnownHostsEntry(args),
  }
}

export function hostedSessionName(host: string, port: number, projectName: string) {
  const alias = hostedSshAlias(host, port)
  const slug = projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "").slice(0, 20) || "project"
  return `${alias}-${slug}-${stableHash(projectName)}`
}

export function buildMutagenCreateCommand(args: {
  localPath: string
  projectName: string
  sshUser: string
  sshHost: string
  sshPort: number
  workspaceRoot: string
}) {
  // Mutagen uses OpenSSH's SCP-style endpoint syntax, not ssh:// URLs.
  const remote = `${args.sshUser}@${hostedSshAlias(args.sshHost, args.sshPort)}:${args.workspaceRoot}/${args.projectName}`
  const ignorePatterns = [".git", ".kanna", ".remote-workspace", ".ssh", ".codex/auth.json", ".aws/credentials", "node_modules", "vendor", ".venv", "venv", "target", "dist", "build", ".next", ".turbo", ".cache", ".pytest_cache", "__pycache__", ".env", ".env.*", "secrets", "*.pem", "*.key"]
    .map((pattern) => `--ignore ${shellQuotePosix(pattern)}`)
    .join(" ")
  const session = hostedSessionName(args.sshHost, args.sshPort, args.projectName)
  return `mutagen sync create --name ${shellQuotePosix(session)} --sync-mode=two-way-safe --ignore-vcs ${ignorePatterns} ${shellQuotePosix(args.localPath)} ${shellQuotePosix(remote)}`
}
