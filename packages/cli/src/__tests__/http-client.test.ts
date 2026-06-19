/**
 * Unit tests for the CLI HTTP client.
 *
 * Focuses on construction-time normalisation (trailing-slash stripping) so
 * that commands work correctly regardless of how the user configured their
 * platform URL in their profile or environment variable.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHttpClient } from "../lib/http-client.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHttpClient — trailing slash normalisation", () => {
  function makeCfg(platformUrl: string) {
    return {
      platformUrl,
      apiKey: "op_live_test",
      timeout: 5_000,
      insecureTls: false,
      verbose: false,
    };
  }

  it("strips a single trailing slash from platformUrl", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createHttpClient(makeCfg("https://api.example.com/"));
    await client.get("/api/v1/data");

    const calledUrl: string = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).not.toContain("//api/");
    expect(calledUrl).toMatch(/^https:\/\/api\.example\.com\/api\/v1\/data/);
  });

  it("strips multiple trailing slashes from platformUrl", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createHttpClient(makeCfg("https://api.example.com///"));
    await client.get("/api/v1/data");

    const calledUrl: string = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toMatch(/^https:\/\/api\.example\.com\/api\/v1\/data/);
  });

  it("leaves a URL without trailing slash unchanged", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createHttpClient(makeCfg("https://api.example.com"));
    await client.get("/api/v1/data");

    const calledUrl: string = fetchSpy.mock.calls[0]![0] as string;
    expect(calledUrl).toMatch(/^https:\/\/api\.example\.com\/api\/v1\/data/);
  });
});
