import { describe, expect, test } from "bun:test"
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto"
import { newKeyPair, openSealed } from "./seal"

/** What kanna.sh does (kanna-site src/worker/cloud/app-handoff.ts). */
function seal(token: string, publicKey: string) {
  const ephemeral = createECDH("prime256v1")
  ephemeral.generateKeys()
  const shared = ephemeral.computeSecret(Buffer.from(publicKey, "base64url"))
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "kanna-app-auth", 32))
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()])
  return Buffer.concat([ephemeral.getPublicKey(), iv, ciphertext, cipher.getAuthTag()]).toString("base64url")
}

describe("openSealed", () => {
  test("opens a session sealed to the app's key", () => {
    const keys = newKeyPair()
    expect(Buffer.from(keys.publicKey, "base64url")).toHaveLength(65)
    expect(openSealed(seal("session-token", keys.publicKey), keys.privateKey)).toBe("session-token")
  })

  test("refuses a seal made for another key, or garbage", () => {
    const keys = newKeyPair()
    expect(openSealed(seal("session-token", newKeyPair().publicKey), keys.privateKey)).toBeNull()
    expect(openSealed("not-a-seal", keys.privateKey)).toBeNull()
  })
})
