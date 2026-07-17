/**
 * Tests for usePipelineRunLogs.
 *
 * The hook creates EventSource directly (not via SSEConnection), so we capture
 * each created instance by extending the globally-installed MockEventSource.
 * Events are dispatched by looking up the registered addEventListener listeners
 * from the MockEventSource's internal listeners map.
 *
 * We use fake timers so that the MockEventSource's async-open setTimeout(0)
 * is under our control.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { MockEventSource } from "@/test/setup.js";
import { usePipelineRunLogs, type LogLine } from "@/hooks/use-pipeline-run-logs.js";

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

/** Fire all "log" event listeners registered on the given EventSource instance. */
function dispatchLog(es: MockEventSource, line: LogLine): void {
  // Access the private listeners map via the public dispatchEvent path.
  // We construct a real MessageEvent and dispatch it, which invokes all
  // addEventListener("log", ...) callbacks through the MockEventSource's
  // dispatchEvent implementation.
  const event = new MessageEvent("log", {
    data: JSON.stringify(line),
  });
  es.dispatchEvent(event);
}

/** Fire all "done" event listeners on the given EventSource instance. */
function dispatchComplete(es: MockEventSource): void {
  const event = new MessageEvent("done", { data: "" });
  es.dispatchEvent(event);
}

function makeLogLine(overrides: Partial<LogLine> = {}): LogLine {
  return {
    timestamp: "2026-01-01T00:00:00Z",
    level: "info",
    message: "hello",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("usePipelineRunLogs", () => {
  it("opens an EventSource at the correct URL with withCredentials true", () => {
    renderHook(() => usePipelineRunLogs("run-123"));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.url).toBe("/api/v1/pipeline-runs/run-123/logs");
    expect(instances[0]!.withCredentials).toBe(true);
  });

  it("appends a received log line to the logs array", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      dispatchLog(es, makeLogLine({ message: "step started" }));
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]!.message).toBe("step started");
  });

  it("skips a log event carrying malformed JSON without throwing", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      // Send a valid line first so we can confirm the bad line is simply dropped
      dispatchLog(es, makeLogLine({ message: "ok" }));
      es.dispatchEvent(new MessageEvent("log", { data: "{not json" }));
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.logs[0]!.message).toBe("ok");
  });

  it("sets isComplete=true and closes the EventSource when a 'done' event fires", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      dispatchComplete(es);
    });

    expect(result.current.isComplete).toBe(true);
    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });

  it("evicts the oldest lines when the buffer exceeds 10 000 lines", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      // Push 10 001 lines — the oldest should be evicted, leaving exactly 10 000
      for (let i = 0; i < 10_001; i++) {
        dispatchLog(es, makeLogLine({ message: `line-${i}` }));
      }
    });

    expect(result.current.logs).toHaveLength(10_000);
    // The first line (line-0) must have been evicted
    expect(result.current.logs[0]!.message).toBe("line-1");
    expect(result.current.logs[9_999]!.message).toBe("line-10000");
  });

  it("resets logs and isComplete when runId changes", () => {
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => usePipelineRunLogs(runId),
      { initialProps: { runId: "run-A" } },
    );
    const firstEs = instances[0]!;

    act(() => {
      dispatchLog(firstEs, makeLogLine({ message: "from run-A" }));
      dispatchComplete(firstEs);
    });

    expect(result.current.logs).toHaveLength(1);
    expect(result.current.isComplete).toBe(true);

    // Switch to a new run — the hook must reset all state
    act(() => {
      rerender({ runId: "run-B" });
    });

    expect(result.current.logs).toHaveLength(0);
    expect(result.current.isComplete).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("sets error state when EventSource enters CLOSED state on error", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      // Simulate the EventSource being closed before onerror fires —
      // the hook checks readyState === CLOSED to decide whether to surface an error
      es.close(); // sets readyState to CLOSED
      es.onerror?.(new Event("error"));
    });

    expect(result.current.error).toBe("Connection lost — log stream unavailable");
  });

  it("does not set error state when onerror fires but the connection is not yet CLOSED", () => {
    const { result } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    act(() => {
      // readyState is still CONNECTING/OPEN — native EventSource would retry;
      // the hook should not surface an error in this case
      es.onerror?.(new Event("error"));
    });

    expect(result.current.error).toBeNull();
  });

  it("closes the EventSource on unmount", () => {
    const { unmount } = renderHook(() => usePipelineRunLogs("run-1"));
    const es = instances[0]!;

    unmount();

    expect(es.readyState).toBe(MockEventSource.CLOSED);
  });
});
