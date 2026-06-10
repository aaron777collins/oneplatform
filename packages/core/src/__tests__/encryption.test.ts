import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../encryption.js";

const MASTER_KEY = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000001",
  "hex"
);

describe("encrypt / decrypt", () => {
  it("roundtrip produces identical plaintext", async () => {
    const plaintext = "super-secret-api-key";
    const blob = await encrypt(plaintext, MASTER_KEY);
    const result = await decrypt(blob, MASTER_KEY);
    expect(result).toBe(plaintext);
  });

  it("two encryptions of the same plaintext produce different blobs (random IV + salt)", async () => {
    const plaintext = "same-value";
    const blob1 = await encrypt(plaintext, MASTER_KEY);
    const blob2 = await encrypt(plaintext, MASTER_KEY);
    expect(blob1).not.toBe(blob2);
  });

  it("decryption fails loudly when the master key is wrong", async () => {
    const blob = await encrypt("sensitive", MASTER_KEY);
    const wrongKey = Buffer.from(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "hex"
    );
    await expect(decrypt(blob, wrongKey)).rejects.toThrow();
  });

  it("decryption fails when the blob is tampered", async () => {
    const blob = await encrypt("value", MASTER_KEY);
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    await expect(decrypt(tampered, MASTER_KEY)).rejects.toThrow();
  });

  it("handles empty string plaintext", async () => {
    const blob = await encrypt("", MASTER_KEY);
    const result = await decrypt(blob, MASTER_KEY);
    expect(result).toBe("");
  });

  it("handles unicode plaintext", async () => {
    const plaintext = "密码 🔐 пароль";
    const blob = await encrypt(plaintext, MASTER_KEY);
    expect(await decrypt(blob, MASTER_KEY)).toBe(plaintext);
  });
});
