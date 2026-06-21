/**
 * PWA bootstrap utilities.
 *
 * registerServiceWorker() is called once from main.tsx. It handles:
 * - Service worker registration with update detection
 * - Background sync registration for queued mutations
 * - Incoming sync-complete message handling (data refetch signals)
 *
 * Why not use a library: the spec mandates a hand-rolled service worker and
 * no external PWA libraries. The API surface here is small enough that a
 * library would add more complexity than it removes.
 */

import type { QueryClient } from "@tanstack/react-query";

// ---------------------------------------------------------------------------
// PWA Install Prompt
// ---------------------------------------------------------------------------

// The BeforeInstallPromptEvent is a non-standard extension defined in the
// Chrome/Edge PWA spec. TypeScript's lib.dom.d.ts does not include it, so we
// declare a minimal interface to avoid `any` casts throughout.
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<{ outcome: "accepted" | "dismissed" }>;
}

/**
 * Module-level storage for the deferred install prompt event.
 *
 * The browser fires `beforeinstallprompt` once (before the user has installed
 * the PWA). We capture it here so that UI components can call
 * `promptInstall()` at any later point — e.g. when the user clicks an
 * "Install App" button — without needing to be mounted at the exact moment
 * the event fires.
 */
let deferredInstallPrompt: BeforeInstallPromptEvent | null = null;

/** Callback set by `onInstallAvailable`; invoked when the prompt is captured. */
let installAvailableCallback: (() => void) | null = null;

/**
 * Initialises the install prompt listener.
 *
 * Must be called once during app boot (e.g. in main.tsx). It is idempotent —
 * calling it multiple times registers duplicate listeners but the module-level
 * `deferredInstallPrompt` reference is replaced each time, so only the most
 * recent prompt event is retained.
 */
export function registerInstallPromptListener(): void {
  if (typeof window === "undefined") return;

  window.addEventListener("beforeinstallprompt", (event: Event) => {
    // Prevent the browser's default mini-infobar so we can show our own UI.
    event.preventDefault();
    deferredInstallPrompt = event as BeforeInstallPromptEvent;

    if (installAvailableCallback) {
      installAvailableCallback();
    }
  });

  // Clear the stored prompt once the app is installed so the "Install" button
  // is hidden after a successful install.
  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
  });
}

/**
 * Returns true when a deferred install prompt is available, meaning the app
 * meets the PWA installability criteria and has not yet been installed.
 */
export function isInstallPromptAvailable(): boolean {
  return deferredInstallPrompt !== null;
}

/**
 * Triggers the browser's native install dialog.
 *
 * Resolves with the user's choice ("accepted" | "dismissed") or `null` when
 * no deferred prompt is available (e.g. already installed, or browser does
 * not support installation).
 *
 * The deferred prompt is single-use — the browser clears it after `prompt()`
 * is called, so we also null the module reference.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  if (!deferredInstallPrompt) return null;

  const prompt = deferredInstallPrompt;
  // Clear immediately; if the user dismisses and re-visits, the browser may
  // fire a new beforeinstallprompt later.
  deferredInstallPrompt = null;

  const result = await prompt.prompt();
  return result.outcome;
}

/**
 * Registers a callback that fires once when an install prompt becomes
 * available. Returns an unsubscribe function.
 *
 * Useful for React components: call this in a useEffect and unsubscribe on
 * unmount to avoid stale callbacks keeping component instances alive.
 */
export function onInstallAvailable(callback: () => void): () => void {
  installAvailableCallback = callback;
  // If the prompt was already captured before this call (race during
  // hydration), invoke the callback synchronously.
  if (deferredInstallPrompt) {
    callback();
  }
  return () => {
    if (installAvailableCallback === callback) {
      installAvailableCallback = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SyncCompleteMessage {
  type: "SYNC_COMPLETE";
  replayed: number;
  failed: number;
}

interface ServiceWorkerMessage {
  type: string;
  [key: string]: unknown;
}

type SyncCompleteCallback = (result: SyncCompleteMessage) => void;

// ---------------------------------------------------------------------------
// Service Worker Registration
// ---------------------------------------------------------------------------

/**
 * Registers /sw.js and wires up lifecycle hooks.
 *
 * Call this after React mounts so registration does not block the initial
 * paint. Service worker registration is low-priority I/O that should never
 * delay TTI.
 */
export async function registerServiceWorker(
  queryClient?: QueryClient,
): Promise<ServiceWorkerRegistration | null> {
  // Guard both key presence and value — jsdom defines the property but leaves
  // it undefined; a truthy check is safer than `in` alone.
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) {
    // Service workers are only available in secure contexts (HTTPS or localhost)
    // and are unsupported in some browsers. Degrade gracefully.
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      // Service worker controls documents at its own scope. The default scope
      // is the directory containing sw.js, which is "/" here (public/).
      scope: "/",
    });

    // Notify in development so engineers can see the SW lifecycle
    if (import.meta.env.DEV) {
      registration.addEventListener("updatefound", () => {
        console.info("[SW] Update found — installing new worker");
      });
    }

    // Listen for SYNC_COMPLETE messages from the service worker so we can
    // trigger a refetch of any queries that may be stale after replay.
    if (queryClient !== undefined) {
      navigator.serviceWorker.addEventListener("message", (event: MessageEvent<ServiceWorkerMessage>) => {
        if (event.data?.type === "SYNC_COMPLETE") {
          // Cast via unknown first because ServiceWorkerMessage intentionally
          // carries unknown extra fields; narrowing with the type check above
          // makes the conversion safe.
          const msg = event.data as unknown as SyncCompleteMessage;
          if (msg.replayed > 0) {
            // Invalidate all active queries so UIs reflect the replayed writes
            void queryClient.invalidateQueries();
          }
        }
      });
    }

    return registration;
  } catch (error) {
    // Registration failures are non-fatal — the app works fully without a SW.
    // Log in development; swallow in production to avoid polluting error monitors.
    if (import.meta.env.DEV) {
      console.warn("[SW] Registration failed:", error);
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Background Sync — mutation queue
// ---------------------------------------------------------------------------

/** Shape of a queued mutation stored in IndexedDB. */
export interface QueuedMutation {
  id: string;
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  queuedAt: number;
}

const IDB_NAME = "op-mutation-queue";
const IDB_VERSION = 1;
const IDB_STORE = "mutations";
const MUTATION_SYNC_TAG = "op-mutation-sync";

/**
 * Opens (or creates) the IndexedDB mutation queue.
 * Creating the store inside onupgradeneeded is idempotent.
 */
function openMutationDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(`Failed to open mutation IDB: ${request.error?.message ?? "unknown"}`),
      );
  });
}

/**
 * Enqueues a failed mutation for later replay via Background Sync.
 *
 * Called by api-client when a mutating request fails with a network error
 * (not a 4xx/5xx — those indicate server-side rejection, not connectivity).
 * The service worker reads this queue in its `sync` handler and replays the
 * requests when the device comes back online.
 */
export async function enqueueMutation(mutation: Omit<QueuedMutation, "id" | "queuedAt">): Promise<void> {
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) return;

  const db = await openMutationDb();

  const entry: QueuedMutation = {
    ...mutation,
    id: crypto.randomUUID(),
    queuedAt: Date.now(),
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      const request = store.add(entry);
      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to enqueue mutation: ${request.error?.message ?? "unknown"}`));
    });
  } finally {
    db.close();
  }

  // Request background sync if available — the browser will invoke the
  // service worker's sync event when it detects connectivity.
  try {
    const registration = await navigator.serviceWorker.ready;
    if ("sync" in registration) {
      // Background Sync API — not available in all browsers (notably Firefox)
      await (registration as ServiceWorkerRegistration & { sync: { register: (tag: string) => Promise<void> } }).sync.register(MUTATION_SYNC_TAG);
    }
  } catch {
    // Background Sync is a progressive enhancement — fail silently
  }
}

/**
 * Registers a callback that fires when the service worker reports a
 * sync-complete event. Used in tests and for UI feedback (e.g. toast).
 */
export function onSyncComplete(callback: SyncCompleteCallback): () => void {
  // Guard both the key presence and the value — jsdom defines the property on
  // the navigator prototype but leaves it undefined, so a truthiness check is
  // required in addition to the `in` check.
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker) {
    return () => undefined;
  }

  const handler = (event: MessageEvent<ServiceWorkerMessage>) => {
    if (event.data?.type === "SYNC_COMPLETE") {
      // Cast via unknown — the type check above narrows the intent; unknown
      // makes the double-cast explicit and auditable.
      callback(event.data as unknown as SyncCompleteMessage);
    }
  };

  navigator.serviceWorker.addEventListener("message", handler);
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}
