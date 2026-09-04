import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

const PREFIX = "enc:v1:"

function encryptionKey(): Buffer | null {
  const secret = process.env.HAPROXY_UI_KEY
  if (!secret) return null
  return createHash("sha256").update(secret).digest()
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

/** AES-256-GCM encrypt. Output: enc:v1:<iv>:<tag>:<ciphertext> (all base64). */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey()
  if (!key) return plaintext
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${enc.toString("base64")}`
}

/** Decrypt an encrypted secret. Plaintext values pass through unchanged. */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored
  if (!encryptionKey()) {
    throw new Error(
      "stored secret is encrypted but HAPROXY_UI_KEY is not set; " +
        "start the app with the same HAPROXY_UI_KEY it was encrypted with",
    )
  }
  // stored = "enc:v1:<iv>:<tag>:<data>" → parts: [enc, v1, iv, tag, data]
  const [, , ivB64, tagB64, dataB64] = stored.split(":")
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey()!,
    Buffer.from(ivB64, "base64"),
  )
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8")
}
