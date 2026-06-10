import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeCursor, decodeCursor } from "../cursor.js";
import { InvalidCursorError, CursorExpiredError } from "../errors.js";

const SECRET = "test-cursor-secret-32-chars-pad!!";

describe("encodeCursor / decodeCursor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("roundtrip preserves payload", async () => {
    const payload = { id: "abc-123", createdAt: "2026-01-01T00:00:00.000Z" };
    const cursor = await encodeCursor(payload, SECRET);
    const result = await decodeCursor(cursor, SECRET);
    expect(result).toMatchObject(payload);
  });

  it("throws InvalidCursorError on tampered signature", async () => {
    const cursor = await encodeCursor({ id: "x" }, SECRET);
    const tampered = cursor.slice(0, -4) + "XXXX";
    await expect(decodeCursor(tampered, SECRET)).rejects.toThrow(InvalidCursorError);
  });

  it("throws InvalidCursorError on malformed (non-base64) input", async () => {
    await expect(decodeCursor("!!!invalid!!!", SECRET)).rejects.toThrow(InvalidCursorError);
  });

  it("throws CursorExpiredError when cursor is older than 24 hours", async () => {
    const now = Date.now();
    vi.setSystemTime(now - 25 * 60 * 60 * 1000);
    const cursor = await encodeCursor({ id: "y" }, SECRET);

    vi.setSystemTime(now);
    await expect(decodeCursor(cursor, SECRET)).rejects.toThrow(CursorExpiredError);
  });
});
