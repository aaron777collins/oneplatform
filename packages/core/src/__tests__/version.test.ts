import { describe, it, expect, vi, afterEach } from "vitest";

// readPackageVersion reads the file system, so we mock `node:fs` to keep
// the test hermetic and avoid depending on the actual package.json location.
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

describe("readPackageVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the version string from a valid package.json", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ name: "my-service", version: "1.2.3" })
    );

    const { readPackageVersion } = await import("../version.js");
    const result = readPackageVersion("file:///app/dist/index.js");

    expect(result).toBe("1.2.3");
  });

  it("falls back to 0.0.0-dev when version field is missing", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ name: "my-service" }));

    const { readPackageVersion } = await import("../version.js");
    const result = readPackageVersion("file:///app/dist/index.js");

    expect(result).toBe("0.0.0-dev");
  });

  it("falls back to 0.0.0-dev when version field is not a string", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 42 }));

    const { readPackageVersion } = await import("../version.js");
    const result = readPackageVersion("file:///app/dist/index.js");

    expect(result).toBe("0.0.0-dev");
  });

  it("falls back to 0.0.0-dev when the file cannot be read (ENOENT)", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      throw err;
    });

    const { readPackageVersion } = await import("../version.js");
    const result = readPackageVersion("file:///app/dist/index.js");

    expect(result).toBe("0.0.0-dev");
  });

  it("falls back to 0.0.0-dev when the file contains invalid JSON", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue("not-json{{{");

    const { readPackageVersion } = await import("../version.js");
    const result = readPackageVersion("file:///app/dist/index.js");

    expect(result).toBe("0.0.0-dev");
  });
});
