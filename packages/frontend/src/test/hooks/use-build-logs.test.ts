/**
 * Tests for useBuildLogs.
 *
 * Mirrors the structure of use-pipeline-run-logs.test.ts. The key differences
 * are:
 *   - The hook takes (appId, buildId) and skips opening a connection when
 *     buildId is null.
 *   - The "complete" event carries { status: "success" | "failed" } JSON, and
 *     the hook falls back to "success" when the payload is malformed.
 *   - buildResult is an additional piece of state that must be verified.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MockEventSource } from "@/test/setup.js";
import { useBuildLogs, type BuildLogLine } from "@/hooks/use-build-logs.js";

// ---------------------------------------------------------------------------
// Instance capture
// ---------------------------------------------------------------------------

const instances: MockEventSource[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;

  vi.stubGlobal(
    "EventSource",
    class extends MockEventSource {
      constructor(url: string, opts?: EventSourceInit) {
        super(url, opts);
        instances.push(this);
      }
    },
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dispatchLog(es: MockEventSource, line: BuildLogLine): void {
  es.dispatchEvent(new MessageEvent("log", { data: JSON.stringify(line) }));
}

function dispatchComplete(
  es: MockEventSource,
  status: "success" | "failed" | null = "success",
): void {
  const data = status !== null ? JSON.stringify({ status }) : "{bad json";
  es.dispatchEvent(new MessageEvent("complete", { data }));
}

function makeLogLine(overrides: Partial<BuildLogLine> = {}): BuildLogLine {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    level: "info",
    message: "compiling",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("useBuildLogs", () => {
  it("does not open an EventSource when buildId is null", () => {
    renderHook(() => useBuildLogs("app-1", null));

    expect(instances).toHaveLength(0);
  });

  it("opens an EventSource at the correct URL when buildId is non-null", () => {
    renderHook(() => useBuildLogs("app-42", "build-7"));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toBe(
      "/api/v1/apps/app-42/builds/build-7/logs/stream",
    );
    expect(instances[0]!.withCredentials).toBe(true);
  });

  it("sets buildResult='failed' and isComplete=true when 'complete' carries status:failed", () => {
    const { result } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    act(() => {
      dispatchComplete(es, "failed");
    });

    expect(result.current.buildResult).toBe("failed");
    expect(result.current.isComplete).toBe(true);
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it("falls back to buildResult='success' when 'complete' carries malformed JSON", () => {
    const { result } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    act(() => {
      // dispatchComplete with null passes bad JSON to exercise the catch branch
      dispatchComplete(es, null);
    });

    expect(result.current.buildResult).toBe("success");
    expect(result.current.isComplete).toBe(true);
  });

  it("resets all state when buildId changes", () => {
    const { result, rerender } = renderHook(
      ({ buildId }: { buildId: string }) => useBuildLogs("app-1", buildId),
      { initialProps: { buildId: "build-A" } },
    );
    const firstEs = instances[0]!;

    act(() => {
      dispatchLog(firstEs, makeLogLine({ message: "from build-A" }));
      dispatchComplete(firstEs, "failed");
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.buildResult).toBe("failed");
    expect(result.current.isComplete).toBe(true);

    // Switch to a new build
    act(() => {
      rerender({ buildId: "build-B" });
    });

    expect(result.current.logs).toHaveLength(0);
    expect(result.current.buildResult).toBeNull();
    expect(result.current.isComplete).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("evicts the oldest lines when the buffer exceeds 10 000 lines", () => {
    const { result } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    act(() => {
      for (let i = 0; i < 10_001; i++) {
        dispatchLog(es, makeLogLine({ message: `line-${i}` }));
      }
    });

    expect(result.current.logs).toHaveLength(10_000);
    expect(result.current.logs[0]!.message).toBe("line-1");
    expect(result.current.logs[9_999]!.message).toBe("line-10000");
  });

  it("sets error state when EventSource enters CLOSED state on error", () => {
    const { result } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    act(() => {
      es.close();
      es.onerror?.(new Event("error"));
    });

    expect(result.current.error).toBe("Build log connection lost");
  });

  it("does not set error state when onerror fires without the connection being CLOSED", () => {
    const { result } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    act(() => {
      // readyState is CONNECTING — native EventSource would retry; no error surfaced
      es.onerror?.(new Event("error"));
    });

    expect(result.current.error).toBeNull();
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => useBuildLogs("app-1", "build-1"));
    const es = instances[0]!;

    unmount();

    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });
});
