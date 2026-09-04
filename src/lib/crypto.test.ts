import { afterEach, describe, expect, it } from "vitest"
import { decryptSecret, encryptSecret, isEncrypted } from "./crypto"

afterEach(() => {
  delete process.env.HAPROXY_UI_KEY
})

describe("encryptSecret/decryptSecret without key", () => {
  it("passes plaintext through (backward compatible)", () => {
    expect(encryptSecret("hunter2")).toBe("hunter2")
    expect(decryptSecret("hunter2")).toBe("hunter2")
    expect(isEncrypted("hunter2")).toBe(false)
  })
})

describe("encryptSecret/decryptSecret with key", () => {
  it("roundtrips a secret", () => {
    process.env.HAPROXY_UI_KEY = "test-key"
    const enc = encryptSecret("hunter2")
    expect(isEncrypted(enc)).toBe(true)
    expect(enc).not.toContain("hunter2")
    expect(decryptSecret(enc)).toBe("hunter2")
  })

  it("produces unique ciphertexts (random IV)", () => {
    process.env.HAPROXY_UI_KEY = "test-key"
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"))
  })

  it("decrypts values encrypted under the same key", () => {
    process.env.HAPROXY_UI_KEY = "shared-key"
    const enc = encryptSecret("secret-a")
    expect(decryptSecret(enc)).toBe("secret-a")
  })

  it("decrypting without a key throws a helpful error", () => {
    process.env.HAPROXY_UI_KEY = "test-key"
    const enc = encryptSecret("hunter2")
    delete process.env.HAPROXY_UI_KEY
    expect(() => decryptSecret(enc)).toThrow(/HAPROXY_UI_KEY/)
  })

  it("decrypting under a different key fails (GCM auth)", () => {
    process.env.HAPROXY_UI_KEY = "key-one"
    const enc = encryptSecret("hunter2")
    process.env.HAPROXY_UI_KEY = "key-two"
    expect(() => decryptSecret(enc)).toThrow()
  })

  it("handles unicode and empty strings", () => {
    process.env.HAPROXY_UI_KEY = "test-key"
    for (const v of ["", "p@ss wörd 中文!", "x".repeat(1000)]) {
      expect(decryptSecret(encryptSecret(v))).toBe(v)
    }
  })
})
