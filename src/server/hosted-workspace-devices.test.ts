import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { HostedWorkspaceDeviceKeys, isHostedWorkspaceDeviceKey } from "./hosted-workspace-devices"

function testPublicKey(seed: number) {
  const algorithm = Buffer.from("ssh-ed25519")
  const blob = Buffer.alloc(4 + algorithm.length + 4 + 32)
  blob.writeUInt32BE(algorithm.length, 0)
  algorithm.copy(blob, 4)
  blob.writeUInt32BE(32, 4 + algorithm.length)
  blob.fill(seed, 8 + algorithm.length)
  return `ssh-ed25519 ${blob.toString("base64")}`
}

describe("hosted workspace device keys", () => {
  test("validates Ed25519 public keys and rejects multiline or mismatched keys", () => {
    const key = testPublicKey(1)
    expect(isHostedWorkspaceDeviceKey(key)).toBe(true)
    expect(isHostedWorkspaceDeviceKey(`${key}\nssh-ed25519 AAAA`)).toBe(false)
    expect(isHostedWorkspaceDeviceKey(`ssh-rsa ${key.split(" ")[1]}`)).toBe(false)
  })

  test("registers idempotently, lists metadata, and revokes only its device line", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-workspace-device-keys-"))
    try {
      const directory = path.join(root, "device-keys")
      const store = new HostedWorkspaceDeviceKeys(directory)
      const key = testPublicKey(2)
      const { deviceId } = await store.register(key, "Laptop")
      expect(deviceId).toMatch(/^[a-f0-9]{32}$/)
      expect(await store.list()).toEqual([{
        id: deviceId,
        label: "Laptop",
        fingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]+$/),
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      }])
      expect(await store.register(`${key} supplied-comment`, "renamed laptop")).toEqual({ deviceId })
      expect(await store.list()).toHaveLength(1)
      const authorizedLine = (await readFile(path.join(directory, "authorized_keys"), "utf8")).trim().split(" ")
      expect(authorizedLine.slice(0, 2).join(" ")).toBe(key)
      expect(authorizedLine[2]).toBe("kanna-device-v1")
      expect(authorizedLine[3]).toBe(deviceId)
      expect(Number.isNaN(Date.parse(authorizedLine[4]!))).toBe(false)
      expect(authorizedLine[5]).toBe(Buffer.from("Laptop").toString("base64url"))
      expect((await stat(path.join(directory, "authorized_keys"))).mode & 0o777).toBe(0o600)
      expect(await store.revoke("f".repeat(32))).toBe(false)
      expect(await store.revoke(deviceId)).toBe(true)
      expect(await store.list()).toEqual([])
      expect(await readFile(path.join(directory, "authorized_keys"), "utf8")).toBe("")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects invalid labels and serializes concurrent registration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kanna-workspace-device-race-"))
    try {
      const store = new HostedWorkspaceDeviceKeys(path.join(root, "device-keys"))
      const key = testPublicKey(3)
      await expect(store.register(key, "bad\nlabel")).rejects.toThrow("invalid_device")
      const [first, second] = await Promise.all([store.register(key, "one"), store.register(key, "two")])
      expect(first.deviceId).toBe(second.deviceId)
      expect(await store.list()).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
