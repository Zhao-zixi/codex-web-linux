import { createDecipheriv, createECDH, hkdfSync } from "node:crypto"

/**
 * The crypto half of app-auth.ts, apart from Electron so `bun test` can run
 * it. kanna.sh seals the session to the app's P-256 key (kanna-site
 * src/worker/cloud/app-handoff.ts): ECDH with a throwaway key, HKDF-SHA256
 * with info "kanna-app-auth" and an empty salt, AES-256-GCM.
 */
export function newKeyPair() {
  const ecdh = createECDH("prime256v1")
  ecdh.generateKeys()
  return { privateKey: ecdh.getPrivateKey("hex"), publicKey: base64URL(ecdh.getPublicKey()) }
}

/** `ephemeralPublicKey (65) ‖ iv (12) ‖ ciphertext ‖ tag (16)`, base64url. */
export function openSealed(sealed: string, privateKeyHex: string): string | null {
  try {
    const data = Buffer.from(sealed, "base64url")
    if (data.length <= 65 + 12 + 16) return null
    const ecdh = createECDH("prime256v1")
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, "hex"))
    const shared = ecdh.computeSecret(data.subarray(0, 65))
    const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "kanna-app-auth", 32))
    const body = data.subarray(65)
    const decipher = createDecipheriv("aes-256-gcm", key, body.subarray(0, 12))
    decipher.setAuthTag(body.subarray(body.length - 16))
    return Buffer.concat([decipher.update(body.subarray(12, body.length - 16)), decipher.final()]).toString("utf8")
  } catch {
    return null
  }
}

export function base64URL(data: Buffer) {
  return data.toString("base64url")
}
