import { createHash, randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export interface HostedWorkspaceDevice {
  id: string
  label: string
  fingerprint: string
  createdAt: string
}

interface StoredHostedWorkspaceDevice extends HostedWorkspaceDevice {
  publicKey: string
}

function parseEd25519PublicKey(value: unknown) {
  if (typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value)) return null
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: (.{1,256}))?$/.exec(value.trim())
  if (!match) return null
  const blob = Buffer.from(match[1]!, "base64")
  if (blob.toString("base64").replace(/=+$/, "") !== match[1]!.replace(/=+$/, "")) return null
  if (blob.length !== 4 + 11 + 4 + 32 || blob.readUInt32BE(0) !== 11 || blob.toString("ascii", 4, 15) !== "ssh-ed25519" || blob.readUInt32BE(15) !== 32) return null
  const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`
  return { publicKey: `ssh-ed25519 ${match[1]}`, fingerprint }
}

function encodeLabel(label: string) {
  return Buffer.from(label, "utf8").toString("base64url")
}

function decodeLabel(encoded: string) {
  const label = Buffer.from(encoded, "base64url").toString("utf8")
  return encodeLabel(label) === encoded ? label : null
}

function parseDeviceLine(line: string): StoredHostedWorkspaceDevice | null {
  const match = /^(ssh-ed25519 [A-Za-z0-9+/]+={0,2}) kanna-device-v1 ([a-f0-9]{32}) (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z) ([A-Za-z0-9_-]+)$/.exec(line)
  if (!match) return null
  const key = parseEd25519PublicKey(match[1])
  const label = decodeLabel(match[4]!)
  if (!key || !label || !label.trim() || label.length > 80 || Number.isNaN(Date.parse(match[3]!))) return null
  return { id: match[2]!, label, fingerprint: key.fingerprint, createdAt: match[3]!, publicKey: key.publicKey }
}

/** Stores per-account public device keys in the directory shared read-only with sshd. */
export class HostedWorkspaceDeviceKeys {
  private readonly filePath: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(directory: string) {
    this.filePath = path.join(directory, "authorized_keys")
  }

  private async readDevices(): Promise<StoredHostedWorkspaceDevice[]> {
    let contents: string
    try {
      contents = await readFile(this.filePath, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
      throw error
    }
    const lines = contents.split("\n").filter(Boolean)
    const devices = lines.map(parseDeviceLine)
    if (devices.some((device) => !device) || new Set(devices.map((device) => device!.id)).size !== devices.length || new Set(devices.map((device) => device!.fingerprint)).size !== devices.length) {
      throw new Error("Hosted workspace device registry is invalid")
    }
    return devices as StoredHostedWorkspaceDevice[]
  }

  private async writeDevices(devices: StoredHostedWorkspaceDevice[]) {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.${randomBytes(8).toString("hex")}.tmp`
    const contents = devices.map((device) => `${device.publicKey} kanna-device-v1 ${device.id} ${device.createdAt} ${encodeLabel(device.label)}`).join("\n")
    try {
      await writeFile(temporaryPath, contents ? `${contents}\n` : "", { flag: "wx", mode: 0o600 })
      await rename(temporaryPath, this.filePath)
      await chmod(this.filePath, 0o600)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation)
    this.mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  async list(): Promise<HostedWorkspaceDevice[]> {
    const devices = await this.readDevices()
    return devices.map(({ id, label, fingerprint, createdAt }) => ({ id, label, fingerprint, createdAt }))
  }

  async register(publicKeyInput: unknown, labelInput: unknown): Promise<{ deviceId: string }> {
    const key = parseEd25519PublicKey(publicKeyInput)
    if (!key || typeof labelInput !== "string" || !labelInput.trim() || labelInput.length > 80 || /[\x00-\x1f\x7f]/.test(labelInput)) {
      throw new Error("invalid_device")
    }
    const label = labelInput.trim()
    return this.mutate(async () => {
      const devices = await this.readDevices()
      const existing = devices.find((device) => device.fingerprint === key.fingerprint)
      if (existing) return { deviceId: existing.id }
      const device: StoredHostedWorkspaceDevice = {
        id: randomBytes(16).toString("hex"),
        label,
        fingerprint: key.fingerprint,
        createdAt: new Date().toISOString(),
        publicKey: key.publicKey,
      }
      await this.writeDevices([...devices, device])
      return { deviceId: device.id }
    })
  }

  async revoke(id: string): Promise<boolean> {
    if (!/^[a-f0-9]{32}$/.test(id)) return false
    return this.mutate(async () => {
      const devices = await this.readDevices()
      const remaining = devices.filter((device) => device.id !== id)
      if (remaining.length === devices.length) return false
      await this.writeDevices(remaining)
      return true
    })
  }
}

export function isHostedWorkspaceDeviceKey(value: unknown): value is string {
  return parseEd25519PublicKey(value) !== null
}
