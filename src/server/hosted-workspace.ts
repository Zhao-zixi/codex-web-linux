import { readFile } from "node:fs/promises"
import { isIP } from "node:net"

export interface HostedWorkspaceConfig {
  displayName: string
  sshHost: string
  sshPort: number
  sshUser: string
  workspaceRoot: string
  publicHostKey?: string
  authMode?: "bearer"
  webHost?: string
  webPort?: number
  webOrigin?: string
}

export type HostedWorkspaceSnapshot = HostedWorkspaceConfig | { enabled: false }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n\0]/.test(value)
}

function isValidSshHost(value: unknown): value is string {
  if (!validText(value, 253)) return false
  // Mutagen parses remote endpoints using SCP's host:path form, where IPv6
  // literals are ambiguous. Require an IPv4 address, DNS name, or SSH alias.
  if (isIP(value)) return isIP(value) === 4
  if (value.includes(":") || value.startsWith("[") || value.endsWith("]")) return false
  return value.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
}

export function parseHostedWorkspaceConfig(value: unknown): HostedWorkspaceConfig {
  if (!isRecord(value)) throw new Error("Hosted workspace config must be an object")
  const { displayName, sshHost, sshPort, sshUser, workspaceRoot, publicHostKey, authMode, webHost, webPort, webOrigin } = value
  if (!validText(displayName, 80)) throw new Error("Invalid hosted workspace displayName")
  if (!isValidSshHost(sshHost)) throw new Error("Invalid hosted workspace sshHost")
  if (!Number.isInteger(sshPort) || (sshPort as number) < 1 || (sshPort as number) > 65535) throw new Error("Invalid hosted workspace sshPort")
  if (!validText(sshUser, 64) || !/^[a-z_][a-z0-9_-]*[$]?$/i.test(sshUser)) throw new Error("Invalid hosted workspace sshUser")
  if (workspaceRoot !== "/workspace") throw new Error("Invalid hosted workspace workspaceRoot")
  if (publicHostKey !== undefined && !isSshPublicHostKey(publicHostKey)) {
    throw new Error("Invalid hosted workspace publicHostKey")
  }
  if (authMode !== undefined && authMode !== "bearer") throw new Error("Invalid hosted workspace authMode")
  if (authMode === "bearer") {
    if (!isValidSshHost(webHost)) throw new Error("Invalid hosted workspace webHost")
    if (!Number.isInteger(webPort) || (webPort as number) < 1024 || (webPort as number) > 65535) throw new Error("Invalid hosted workspace webPort")
    if (!validText(webOrigin, 320)) throw new Error("Invalid hosted workspace webOrigin")
    let parsedOrigin: URL
    try {
      parsedOrigin = new URL(webOrigin)
    } catch {
      throw new Error("Invalid hosted workspace webOrigin")
    }
    if (parsedOrigin.protocol !== "https:" || parsedOrigin.origin !== webOrigin || parsedOrigin.hostname !== webHost || parsedOrigin.port !== String(webPort)) {
      throw new Error("Invalid hosted workspace webOrigin")
    }
  } else if (webHost !== undefined || webPort !== undefined || webOrigin !== undefined) {
    throw new Error("Hosted workspace web origin requires bearer authentication")
  }
  return {
    displayName,
    sshHost,
    sshPort: sshPort as number,
    sshUser,
    workspaceRoot,
    ...(publicHostKey ? { publicHostKey } : {}),
    ...(authMode === "bearer" ? { authMode, webHost: webHost as string, webPort: webPort as number, webOrigin: webOrigin as string } : {}),
  }
}

function isSshPublicHostKey(value: unknown): value is string {
  if (!validText(value, 2048)) return false
  const match = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]+={0,2})(?: .{0,256})?$/.exec(value)
  if (!match) return false
  const decoded = Buffer.from(match[2]!, "base64")
  if (decoded.toString("base64").replace(/=+$/, "") !== match[2]!.replace(/=+$/, "") || decoded.length < 8) return false
  const readField = (offset: number): { value: Buffer; next: number } | null => {
    if (offset + 4 > decoded.length) return null
    const length = decoded.readUInt32BE(offset)
    const start = offset + 4
    const next = start + length
    if (length === 0 || next > decoded.length) return null
    return { value: decoded.subarray(start, next), next }
  }
  const algorithm = readField(0)
  if (!algorithm || algorithm.value.toString("ascii") !== match[1]) return false
  if (match[1] === "ssh-ed25519") {
    const key = readField(algorithm.next)
    return !!key && key.value.length === 32 && key.next === decoded.length
  }
  if (match[1] === "ssh-rsa") {
    const exponent = readField(algorithm.next)
    const modulus = exponent && readField(exponent.next)
    return !!modulus && exponent!.value[0]! < 0x80 && modulus.value.length >= 128 && modulus.next === decoded.length
  }
  const curveName = match[1]!.slice("ecdsa-sha2-".length)
  const curve = readField(algorithm.next)
  const point = curve && readField(curve.next)
  const pointLength = curveName === "nistp256" ? 65 : curveName === "nistp384" ? 97 : 133
  return !!point && curve!.value.toString("ascii") === curveName && point.value.length === pointLength && point.value[0] === 4 && point.next === decoded.length
}

export async function readHostedWorkspaceConfig(filePath?: string): Promise<HostedWorkspaceSnapshot> {
  if (!filePath) return { enabled: false }
  try {
    const text = await readFile(filePath, "utf8")
    return parseHostedWorkspaceConfig(JSON.parse(text))
  } catch {
    // Deliberately omit both the file path and parse error; config may contain
    // deployment details. The caller reports this generic startup failure.
    throw new Error("Hosted workspace configuration is invalid or unreadable")
  }
}
