import { describe, it, expect } from "vitest";
import { validateManifest, PluginManifestSchema } from "../manifest/schema.js";

// Minimal valid manifest for use across tests
const VALID_MANIFEST = {
  manifestVersion: "1" as const,
  id: "com.example.my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  type: "connector" as const,
  description: "A test plugin description",
  author: "Example Corp",
  minPlatformVersion: "1.0.0",
  entrypoint: "MyConnector",
  configSchema: { type: "object" },
  bundleChecksum: "a".repeat(64),
  license: "MIT",
};

describe("PluginManifestSchema", () => {
  it("accepts a valid connector manifest", () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
  });

  it("populates default arrays when omitted", () => {
    const result = validateManifest(VALID_MANIFEST);
    if (!result.valid) throw new Error("expected valid");
    expect(result.manifest.hooks).toEqual([]);
    expect(result.manifest.requiredExternalUrls).toEqual([]);
    expect(result.manifest.requiredApis).toEqual([]);
    expect(result.manifest.requiredCredentials).toEqual([]);
  });

  it("rejects invalid manifestVersion", () => {
    const result = validateManifest({ ...VALID_MANIFEST, manifestVersion: "2" });
    expect(result.valid).toBe(false);
  });

  it("rejects non-reverse-domain id", () => {
    const result = validateManifest({ ...VALID_MANIFEST, id: "my-plugin" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.some((e) => e.path === "id")).toBe(true);
    }
  });

  it("rejects invalid SemVer", () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: "1.0" });
    expect(result.valid).toBe(false);
  });

  it("accepts pre-release SemVer", () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: "1.0.0-beta.1" });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid bundleChecksum (not 64-char hex)", () => {
    const result = validateManifest({ ...VALID_MANIFEST, bundleChecksum: "abc" });
    expect(result.valid).toBe(false);
  });

  it("accepts valid bundleChecksum (64-char lowercase hex)", () => {
    const checksum = "a1b2c3d4".repeat(8); // 64 chars
    const result = validateManifest({ ...VALID_MANIFEST, bundleChecksum: checksum });
    expect(result.valid).toBe(true);
  });

  it("rejects gpgFingerprint with wrong format", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      gpgFingerprint: "lowercase-is-wrong",
    });
    expect(result.valid).toBe(false);
  });

  it("accepts valid GPG fingerprint (40-char uppercase hex)", () => {
    const fingerprint = "ABCDEF0123456789ABCDEF0123456789ABCDEF01";
    const result = validateManifest({ ...VALID_MANIFEST, gpgFingerprint: fingerprint });
    expect(result.valid).toBe(true);
  });

  it("rejects hook entrypoint with spaces", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      hooks: [
        {
          stage: "before:ingestion.receive",
          criticality: "critical",
          entrypoint: "not valid",
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects hook priority outside 0-999 range", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      hooks: [
        {
          stage: "before:ingestion.receive",
          criticality: "critical",
          priority: 1000,
          entrypoint: "onBeforeIngestionReceive",
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects requiredExternalUrls with http:// (not https://)", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      requiredExternalUrls: ["http://api.example.com/**"],
    });
    expect(result.valid).toBe(false);
  });

  it("accepts all valid plugin types", () => {
    const types = ["connector", "transformer", "destination", "auth-provider", "widget"] as const;
    for (const type of types) {
      const result = validateManifest({ ...VALID_MANIFEST, type });
      expect(result.valid).toBe(true);
    }
  });

  it("rejects unknown plugin type", () => {
    const result = validateManifest({ ...VALID_MANIFEST, type: "unknown" });
    expect(result.valid).toBe(false);
  });

  it("rejects description shorter than 10 characters", () => {
    const result = validateManifest({ ...VALID_MANIFEST, description: "too short" });
    expect(result.valid).toBe(false);
  });

  it("rejects icon that is not https:// or data URI", () => {
    const result = validateManifest({ ...VALID_MANIFEST, icon: "http://example.com/icon.png" });
    expect(result.valid).toBe(false);
  });

  it("accepts icon as https:// URL", () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      icon: "https://cdn.example.com/icon.png",
    });
    expect(result.valid).toBe(true);
  });

  it("validateManifest returns structured errors with path", () => {
    const result = validateManifest({ ...VALID_MANIFEST, name: "X" });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      const nameError = result.errors.find((e) => e.path === "name");
      expect(nameError).toBeDefined();
    }
  });

  it("PluginManifestSchema.safeParse is callable directly", () => {
    const result = PluginManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
  });
});
