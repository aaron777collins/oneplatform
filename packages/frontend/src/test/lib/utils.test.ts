import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cn, formatDate, truncate, debounce, formatBytes } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// cn — Tailwind class merging
// ---------------------------------------------------------------------------

describe("cn", () => {
  it("resolves conflicting Tailwind classes in favor of the last one", () => {
    // twMerge semantics: p-4 wins over p-2 because padding utilities conflict
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy conditional class values", () => {
    // false && "bar" evaluates to false — clsx strips it, twMerge gets "foo baz"
    expect(cn("foo", false && "bar", "baz")).toBe("foo baz");
  });

  it("returns empty string when called with no arguments", () => {
    expect(cn()).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatDate — locale-aware date formatting
// ---------------------------------------------------------------------------

describe("formatDate", () => {
  it("formats an ISO string into a truthy string", () => {
    const result = formatDate("2024-01-15T10:30:00Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("formats a numeric timestamp into a truthy string", () => {
    // 2024-01-15T10:30:00Z in milliseconds
    const result = formatDate(1705312200000);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// truncate — string shortening with ellipsis
// ---------------------------------------------------------------------------

describe("truncate", () => {
  it("returns the string unchanged when it fits within maxLength", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  it("returns the string unchanged when length equals maxLength exactly", () => {
    // 5 chars, max 5 → no truncation needed
    expect(truncate("hello", 5)).toBe("hello");
  });

  it("truncates and appends an ellipsis when the string exceeds maxLength", () => {
    // "hello world" (11) > 5 → take 4 chars + ellipsis = "hell…"
    expect(truncate("hello world", 5)).toBe("hell…");
  });

  it("returns the string unchanged when its length equals maxLength=1", () => {
    // Implementation guard: str.length (1) <= maxLength (1) → returns as-is.
    // A 1-char string with maxLength 1 has no room for truncation.
    expect(truncate("a", 1)).toBe("a");
  });
});

// ---------------------------------------------------------------------------
// debounce — delayed invocation
// ---------------------------------------------------------------------------

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not call the function before the delay elapses", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    vi.advanceTimersByTime(299);

    expect(fn).not.toHaveBeenCalled();
  });

  it("calls the function exactly once after the delay elapses", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fires only the last call when invoked multiple times within the delay window", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced("first");
    vi.advanceTimersByTime(100);
    debounced("second");
    vi.advanceTimersByTime(100);
    debounced("third");
    // Only 200ms have passed since "third", so no call yet
    vi.advanceTimersByTime(300);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("third");
  });

  it("cancel() prevents the pending invocation from firing", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 300);

    debounced();
    debounced.cancel();
    vi.advanceTimersByTime(500);

    expect(fn).not.toHaveBeenCalled();
  });

  it("forwards all arguments to the underlying function", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 100);

    debounced("arg1", "arg2");
    vi.advanceTimersByTime(100);

    expect(fn).toHaveBeenCalledWith("arg1", "arg2");
  });
});

// ---------------------------------------------------------------------------
// formatBytes — byte count formatting
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("returns '0 B' for zero bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats exactly 1 KB (1024 bytes)", () => {
    expect(formatBytes(1024)).toBe("1 KB");
  });

  it("formats exactly 1 MB (1048576 bytes)", () => {
    expect(formatBytes(1048576)).toBe("1 MB");
  });

  it("respects the decimals parameter for fractional values", () => {
    // parseFloat strips trailing zeros: toFixed(2) → "1.50" → parseFloat → 1.5 → "1.5 KB"
    // The decimals param controls precision before parseFloat, not the output width.
    expect(formatBytes(1536, 2)).toBe("1.5 KB");
  });

  it("formats exactly 1 TB", () => {
    expect(formatBytes(1099511627776)).toBe("1 TB");
  });
});
