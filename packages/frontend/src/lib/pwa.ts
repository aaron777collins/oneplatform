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

// ---------------------------------------------------------------------------
// MU-011: Web Push Notification Subscriptions
//
// Web Push allows the server to send notifications to the user even when the
// app is not open, using the browser's push service as an intermediary. The
// client-side flow is:
//   1. Check push support (isPushSupported).
//   2. Request Notification permission.
//   3. Subscribe via the PushManager API using the server's VAPID public key.
//   4. Send the resulting PushSubscription endpoint to the API so the server
//      can target this browser for future push messages.
//
// The server-side push (calling the push service, encrypting the payload) is
// NOT implemented here — these functions are the client-side plumbing only.
// Server implementation requires:
//   - web-push npm package (or equivalent)
//   - VAPID key pair (generate once with `npx web-push generate-vapid-keys`)
//   - OP_VAPID_PUBLIC_KEY and OP_VAPID_PRIVATE_KEY environment variables
//   - A /api/push/subscriptions endpoint to store and manage subscriptions
// ---------------------------------------------------------------------------

/**
 * Returns true when the current browser supports Web Push notifications.
 *
 * Checks for:
 * - Service Worker support (required as the push event fires in the SW)
 * - PushManager support (the subscription API)
 * - Notification support (permission API)
 */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * The shape of a push subscription persisted to the API.
 * Mirrors the W3C PushSubscription JSON serialisation.
 */
export interface PushSubscriptionPayload {
  endpoint: string;
  keys: {
    /** Base64url-encoded public key (P-256). */
    p256dh: string;
    /** Base64url-encoded authentication secret. */
    auth: string;
  };
  /** ISO timestamp — lets the server expire stale subscriptions. */
  subscribedAt: string;
  /** User-Agent string — for diagnostics, never used for targeting. */
  userAgent: string;
}

/**
 * Converts a VAPID public key string (Base64url) to the ArrayBuffer that
 * PushManager.subscribe() expects as `applicationServerKey`.
 *
 * Returns ArrayBuffer rather than Uint8Array to avoid the
 * Uint8Array<ArrayBufferLike> vs Uint8Array<ArrayBuffer> mismatch under
 * TypeScript's strict generic variance — ArrayBuffer satisfies BufferSource
 * directly.
 */
function vapidKeyToArrayBuffer(base64UrlKey: string): ArrayBuffer {
  // Replace URL-safe chars and add padding so atob() can decode it.
  const base64 = base64UrlKey.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const raw = window.atob(padded);
  const buffer = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i++) {
    view[i] = raw.charCodeAt(i);
  }
  return buffer;
}

/**
 * Requests Notification permission and subscribes to Web Push.
 *
 * @param vapidPublicKey - The VAPID public key from OP_VAPID_PUBLIC_KEY.
 *   Obtain it via GET /api/push/vapid-public-key (the server exposes it).
 * @param apiEndpoint - URL to POST the subscription payload to.
 *   Defaults to "/api/push/subscriptions".
 *
 * @returns The saved PushSubscriptionPayload, or null when:
 *   - Push is not supported in this browser
 *   - The user denied notification permission
 *   - Service worker registration is unavailable
 *
 * @throws When the API call to save the subscription fails (non-2xx response).
 *   The caller should surface a recoverable error to the user — the push
 *   subscription is still active in the browser even if the API save fails,
 *   so a retry is correct rather than re-subscribing.
 */
export async function subscribeToPush(
  vapidPublicKey: string,
  apiEndpoint = "/api/push/subscriptions",
): Promise<PushSubscriptionPayload | null> {
  if (!isPushSupported()) {
    return null;
  }

  // Request permission before subscribing — the subscribe() call will also
  // prompt but requesting here gives us a clean "denied" check first.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    return null;
  }

  // Wait for an active service worker registration.
  // `navigator.serviceWorker.ready` resolves once a SW controls the page.
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch {
    // Service worker registration failed or was never set up.
    return null;
  }

  // Subscribe. The browser generates a unique endpoint URL and key pair for
  // this (origin, service worker, VAPID key) combination. userVisibleOnly=true
  // is required by Chrome — the push service will reject subscriptions that do
  // not show a notification for every push message received.
  let subscription: PushSubscription;
  try {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidKeyToArrayBuffer(vapidPublicKey),
    });
  } catch (err) {
    // Most common causes: VAPID key is invalid, or the user blocked push in
    // browser settings after granting permission in the Notification prompt.
    throw new Error(
      `Push subscription failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Serialise the PushSubscription to the shape our API expects.
  const json = subscription.toJSON();
  if (json.endpoint === undefined || json.keys === undefined) {
    // Malformed subscription from the browser — should not happen in practice.
    throw new Error("Push subscription is missing endpoint or keys — cannot save.");
  }

  const payload: PushSubscriptionPayload = {
    endpoint: json.endpoint,
    keys: {
      p256dh: json.keys["p256dh"] ?? "",
      auth: json.keys["auth"] ?? "",
    },
    subscribedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
  };

  // Persist the subscription to the API so the server can send push messages.
  const response = await fetch(apiEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    // Credentials are needed so the server can associate the subscription with
    // the authenticated user's account.
    credentials: "include",
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to save push subscription to API (${response.status}): ${body}`,
    );
  }

  return payload;
}

/**
 * Unsubscribes from Web Push and optionally removes the subscription from
 * the API.
 *
 * @param apiEndpoint - URL to DELETE the subscription from. When provided, a
 *   DELETE request is sent with the endpoint in the body. Omit to only
 *   unsubscribe locally without contacting the server.
 */
export async function unsubscribeFromPush(apiEndpoint?: string): Promise<void> {
  if (!isPushSupported()) return;

  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.ready;
  } catch {
    return;
  }

  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  if (apiEndpoint !== undefined) {
    // Best-effort — the browser-side unsubscription already invalidated the
    // endpoint. The server will naturally drop stale subscriptions on next use.
    await fetch(apiEndpoint, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
      credentials: "include",
    }).catch(() => undefined);
  }
}

/**
 * Returns the current push subscription for this browser, or null when not
 * subscribed. Useful for showing a toggle in settings UI without re-prompting.
 */
export async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;

  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
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
