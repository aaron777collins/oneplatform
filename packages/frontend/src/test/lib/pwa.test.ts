/**
 * pwa.ts unit tests — service worker registration and mutation queue.
 *
 * navigator.serviceWorker is not available in jsdom so we mock it explicitly.
 * We test the branch logic rather than browser internals (we do not test that
 * the browser invokes the SW handler).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// navigator.serviceWorker mock
// ---------------------------------------------------------------------------

interface MockRegistration {
  scope: string;
  addEventListener: ReturnType<typeof vi.fn>;
  sync?: { register: ReturnType<typeof vi.fn> };
}

function createMockRegistration(withSync = false): MockRegistration {
  const reg: MockRegistration = {
    scope: "/",
    addEventListener: vi.fn(),
  };
  if (withSync) {
    reg.sync = { register: vi.fn().mockResolvedValue(undefined) };
  }
  return reg;
}

// ---------------------------------------------------------------------------
// Helpers to install / remove the SW mock
// ---------------------------------------------------------------------------

function installSwMock(
  registration: MockRegistration | null,
  rejectWith?: Error,
) {
  const addEventListenerMock = vi.fn();
  const mock = {
    register: rejectWith
      ? vi.fn().mockRejectedValue(rejectWith)
      : vi.fn().mockResolvedValue(registration),
    ready: Promise.resolve(registration),
    addEventListener: addEventListenerMock,
    removeEventListener: vi.fn(),
  };
  Object.defineProperty(navigator, "serviceWorker", {
    value: mock,
    configurable: true,
    writable: true,
  });
  return mock;
}

function removeSwMock() {
  // Set serviceWorker to undefined (falsy) so the pwa.ts guards treat it as
  // unavailable. We cannot delete it from the prototype, but the truthiness
  // guard `!navigator.serviceWorker` handles the undefined value correctly.
  Object.defineProperty(navigator, "serviceWorker", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerServiceWorker", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    removeSwMock();
    vi.restoreAllMocks();
  });

  it("returns null when serviceWorker is not in navigator", async () => {
    removeSwMock();
    const { registerServiceWorker } = await import("@/lib/pwa.js");
    const result = await registerServiceWorker();
    expect(result).toBeNull();
  });

  it("calls navigator.serviceWorker.register with /sw.js and scope /", async () => {
    const reg = createMockRegistration();
    const swMock = installSwMock(reg);
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    await registerServiceWorker();

    expect(swMock.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
  });

  it("returns the registration object on success", async () => {
    const reg = createMockRegistration();
    installSwMock(reg);
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    const result = await registerServiceWorker();

    expect(result).toBe(reg);
  });

  it("returns null (does not throw) when registration rejects", async () => {
    installSwMock(null, new Error("SW registration failed"));
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    const result = await registerServiceWorker();

    expect(result).toBeNull();
  });

  it("attaches a message listener to invalidate queries on SYNC_COMPLETE", async () => {
    const reg = createMockRegistration();
    const swMock = installSwMock(reg);
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    const mockQueryClient = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
    await registerServiceWorker(mockQueryClient as never);

    expect(swMock.addEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });

  it("calls invalidateQueries when a SYNC_COMPLETE message with replayed > 0 arrives", async () => {
    const reg = createMockRegistration();
    const swMock = installSwMock(reg);
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    const mockQueryClient = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
    await registerServiceWorker(mockQueryClient as never);

    // Find and invoke the message handler registered on navigator.serviceWorker
    const handler = (swMock.addEventListener as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as (event: MessageEvent) => void;
    expect(handler).toBeDefined();

    handler({ data: { type: "SYNC_COMPLETE", replayed: 3, failed: 0 } } as MessageEvent);

    expect(mockQueryClient.invalidateQueries).toHaveBeenCalled();
  });

  it("does not invalidate queries when SYNC_COMPLETE has replayed === 0", async () => {
    const reg = createMockRegistration();
    const swMock = installSwMock(reg);
    const { registerServiceWorker } = await import("@/lib/pwa.js");

    const mockQueryClient = { invalidateQueries: vi.fn().mockResolvedValue(undefined) };
    await registerServiceWorker(mockQueryClient as never);

    const handler = (swMock.addEventListener as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as (event: MessageEvent) => void;
    handler({ data: { type: "SYNC_COMPLETE", replayed: 0, failed: 1 } } as MessageEvent);

    expect(mockQueryClient.invalidateQueries).not.toHaveBeenCalled();
  });
});

describe("onSyncComplete", () => {
  afterEach(() => {
    removeSwMock();
    vi.restoreAllMocks();
  });

  it("returns a no-op cleanup function when serviceWorker is absent", async () => {
    removeSwMock();
    const { onSyncComplete } = await import("@/lib/pwa.js");
    const cleanup = onSyncComplete(vi.fn());
    expect(() => cleanup()).not.toThrow();
  });

  it("registers a message listener and fires callback on SYNC_COMPLETE", async () => {
    const swMock = installSwMock(createMockRegistration());
    const { onSyncComplete } = await import("@/lib/pwa.js");

    const callback = vi.fn();
    onSyncComplete(callback);

    // Retrieve the listener and simulate a message
    const handler = (swMock.addEventListener as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[1] as (event: MessageEvent) => void;
    const msg = { type: "SYNC_COMPLETE", replayed: 2, failed: 0 };
    handler({ data: msg } as MessageEvent);

    expect(callback).toHaveBeenCalledWith(msg);
  });

  it("returns a cleanup function that removes the listener", async () => {
    const swMock = installSwMock(createMockRegistration());
    const { onSyncComplete } = await import("@/lib/pwa.js");

    const callback = vi.fn();
    const cleanup = onSyncComplete(callback);
    cleanup();

    expect(swMock.removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });
});
