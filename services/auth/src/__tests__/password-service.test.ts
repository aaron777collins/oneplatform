// Unit tests for password-service.ts
// Covers: hash(), compare(), compareDummy().
// Note: bcrypt rounds are set to 10 (minimum) to keep tests fast.

import { describe, it, expect, beforeEach, vi } from "vitest";

describe("PasswordService", () => {
  beforeEach(() => {
    // Use minimum rounds so tests don't time out; still a real bcrypt hash
    process.env["OP_BCRYPT_ROUNDS"] = "10";
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // hash()
  // -------------------------------------------------------------------------

  describe("hash()", () => {
    it("returns a bcrypt hash that starts with $2b$", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("correct-horse-battery");
      expect(hash).toMatch(/^\$2b\$/);
    });

    it("returns a different hash on each call for the same password (unique salts)", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash1 = await svc.hash("same-password-here!");
      const hash2 = await svc.hash("same-password-here!");
      expect(hash1).not.toBe(hash2);
    });

    it("throws when password is an empty string", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      await expect(svc.hash("")).rejects.toThrow("Password must not be empty");
    });

    it("hashes passwords containing unicode characters", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("pässwörd_中文_12");
      expect(hash).toMatch(/^\$2b\$/);
    });
  });

  // -------------------------------------------------------------------------
  // compare()
  // -------------------------------------------------------------------------

  describe("compare()", () => {
    it("returns true when the password matches the stored hash", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("correct-horse-battery-staple");
      expect(await svc.compare("correct-horse-battery-staple", hash)).toBe(true);
    });

    it("returns false when the password does not match the stored hash", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("correct-password-here!");
      expect(await svc.compare("wrong-password!!", hash)).toBe(false);
    });

    it("returns false when password is an empty string", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("some-valid-password!!");
      expect(await svc.compare("", hash)).toBe(false);
    });

    it("returns false when storedHash is an empty string", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      expect(await svc.compare("some-password-here", "")).toBe(false);
    });

    it("is case-sensitive: different case does not match", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      const hash = await svc.hash("StrongPassword123!");
      expect(await svc.compare("strongpassword123!", hash)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // compareDummy()
  // -------------------------------------------------------------------------

  describe("compareDummy()", () => {
    it("always returns false regardless of input", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      // The dummy hash is random, so no real input should ever match
      expect(await svc.compareDummy("any-password-whatsoever")).toBe(false);
    });

    it("returns false for an empty string (no shortcut)", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      expect(await svc.compareDummy("")).toBe(false);
    });

    it("completes without throwing for extremely long input", async () => {
      const { createPasswordService } = await import("../services/password-service.js");
      const svc = createPasswordService();
      // bcrypt silently truncates at 72 bytes; it should not throw
      const longInput = "A".repeat(1000);
      await expect(svc.compareDummy(longInput)).resolves.toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Configuration guards
  // -------------------------------------------------------------------------

  describe("resolveRounds() configuration guard", () => {
    it("throws when OP_BCRYPT_ROUNDS is set below the minimum of 10", async () => {
      process.env["OP_BCRYPT_ROUNDS"] = "9";
      vi.resetModules();
      // The guard fires at createPasswordService() time (resolveRounds() is called immediately)
      await expect(
        import("../services/password-service.js").then((m) => m.createPasswordService()),
      ).rejects.toThrow("at least 10");
    });

    it("throws when OP_BCRYPT_ROUNDS is not a valid integer", async () => {
      process.env["OP_BCRYPT_ROUNDS"] = "abc";
      vi.resetModules();
      await expect(
        import("../services/password-service.js").then((m) => m.createPasswordService()),
      ).rejects.toThrow("must be an integer");
    });

    it("uses default rounds of 12 when OP_BCRYPT_ROUNDS is not set", async () => {
      delete process.env["OP_BCRYPT_ROUNDS"];
      vi.resetModules();
      const { createPasswordService } = await import("../services/password-service.js");
      // Should not throw — default is 12
      const svc = createPasswordService();
      const hash = await svc.hash("valid-password-here!!");
      // $2b$12$ is the cost-12 prefix
      expect(hash).toMatch(/^\$2b\$12\$/);
    });
  });
});
