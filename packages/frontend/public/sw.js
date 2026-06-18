/**
 * OnePlatform Service Worker
 *
 * Strategy rationale:
 * - Static assets (JS, CSS, images): cache-first so the app loads instantly
 *   on repeat visits regardless of network quality.
 * - API calls (/api, /bff, /v1): network-first so users always see fresh data
 *   when online; fall through to a 503 when offline rather than serving stale
 *   business data that could mislead.
 * - Mutations queued via Background Sync are retried by the browser when
 *   connectivity is restored, eliminating silent data loss on flaky connections.
 *
 * The offline fallback page is pre-cached during install so it is always
 * available even when the main bundle has not been cached yet.
 */

const CACHE_VERSION = "v1";
const STATIC_CACHE = `op-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// These paths are cached eagerly during the install phase.
const PRECACHE_URLS = [OFFLINE_URL];

// Background sync queue name — must match the name used when registering the
// sync event in the client (see registerMutationSync in pwa.ts).
const MUTATION_SYNC_TAG = "op-mutation-sync";

// ---------------------------------------------------------------------------
// Install — cache offline shell
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // Activate immediately — do not wait for existing tabs to close.
      // Safe here because asset URLs are content-hashed by Vite so stale
      // tabs that fetched the old hash still get their files from cache.
      .then(() => self.skipWaiting()),
  );
});

// ---------------------------------------------------------------------------
// Activate — prune stale cache versions
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        const stale = cacheNames.filter(
          (name) =>
            (name.startsWith("op-static-") || name.startsWith("op-")) &&
            name !== STATIC_CACHE,
        );
        return Promise.all(stale.map((name) => caches.delete(name)));
      })
      .then(() => self.clients.claim()),
  );
});

// ---------------------------------------------------------------------------
// Fetch — routing
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin requests. Cross-origin (CDN, analytics, etc.)
  // are left to the browser's default behaviour.
  if (url.origin !== self.location.origin) return;

  // API calls: network-first
  if (isApiRequest(url.pathname)) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Navigation requests: network-first with offline fallback page
  if (request.mode === "navigate") {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Static assets: cache-first
  event.respondWith(cacheFirst(request));
});

// ---------------------------------------------------------------------------
// Background Sync — replay queued mutations
// ---------------------------------------------------------------------------

self.addEventListener("sync", (event) => {
  if (event.tag === MUTATION_SYNC_TAG) {
    event.waitUntil(replayQueuedMutations());
  }
});

// ---------------------------------------------------------------------------
// Strategy implementations
// ---------------------------------------------------------------------------

/**
 * cache-first: returns the cached response immediately when present.
 * Falls back to the network and caches the result for future requests.
 * Used for Vite-emitted assets (content-hashed filenames) where staleness
 * is impossible by definition.
 */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    // Only cache successful, opaque-safe responses
    if (response.ok || response.type === "opaque") {
      const cache = await caches.open(STATIC_CACHE);
      // Clone before consuming — a Response body can only be read once
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // No network and no cache — nothing useful to return for a static asset
    return new Response("Asset unavailable offline", { status: 503 });
  }
}

/**
 * network-first: always tries the network; falls back to cache on failure.
 * Used for API calls where freshness is more important than speed.
 */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Cache successful GET responses so they're available on reconnect
    if (request.method === "GET" && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: "Offline", message: "No network connection" }),
      {
        status: 503,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

/**
 * Navigation handler: network-first for page loads, falls back to the
 * offline shell rather than a browser error page so the user sees a
 * branded experience and can retry gracefully.
 */
async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(OFFLINE_URL);
    if (cached) return cached;
    // Last resort — the offline page itself wasn't cached (install failed)
    return new Response(
      "<!doctype html><html><body><h1>Offline</h1><p>Please check your connection.</p></body></html>",
      { headers: { "Content-Type": "text/html" } },
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true when the path is an API call that must not be served stale. */
function isApiRequest(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/bff/") ||
    pathname.startsWith("/v1/")
  );
}

/**
 * Reads queued mutations from IndexedDB and replays them.
 * The client stores failed writes in IDB when offline; the sync event fires
 * when connectivity is restored (handled in pwa.ts on the client side).
 */
async function replayQueuedMutations() {
  // Open the IDB store written by the client-side queue
  const db = await openMutationDb();
  const mutations = await getAllMutations(db);

  const results = await Promise.allSettled(
    mutations.map(async (mutation) => {
      const response = await fetch(mutation.url, {
        method: mutation.method,
        headers: mutation.headers,
        body: mutation.body,
      });
      if (!response.ok) {
        throw new Error(`Mutation replay failed: ${response.status}`);
      }
      // Remove successfully replayed mutation from the queue
      await deleteMutation(db, mutation.id);
    }),
  );

  // Notify open clients so they can refetch affected data
  const clients = await self.clients.matchAll({ type: "window" });
  const failedCount = results.filter((r) => r.status === "rejected").length;
  clients.forEach((client) => {
    client.postMessage({
      type: "SYNC_COMPLETE",
      replayed: mutations.length - failedCount,
      failed: failedCount,
    });
  });
}

// ---------------------------------------------------------------------------
// IndexedDB helpers (mutation queue)
// ---------------------------------------------------------------------------

const IDB_NAME = "op-mutation-queue";
const IDB_VERSION = 1;
const IDB_STORE = "mutations";

function openMutationDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function getAllMutations(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function deleteMutation(db, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
