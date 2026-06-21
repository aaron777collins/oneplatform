/**
 * HTTP client wrapping fetch for all API calls.
 * The CLI does not make raw fetch calls — all calls go through this interface.
 * Currently implemented with native fetch (Node 22+). When @oneplatform/sdk
 * exports a typed client, that becomes the implementation here.
 *
 * This separation means command actions only depend on the HttpClient interface,
 * making them straightforward to unit-test with a mock implementation.
 */
import { CliError, EXIT, httpErrorToCliError } from "./errors.js";

export interface HttpClient {
  get<T>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  delete(path: string): Promise<void>;
  postMultipart<T>(path: string, form: FormData): Promise<T>;
  stream(path: string, query?: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<string>;
}

export interface HttpClientConfig {
  platformUrl: string;
  apiKey: string | null;
  timeout: number;
  insecureTls: boolean;
  verbose: boolean;
}

function buildUrl(base: string, path: string, query?: Record<string, unknown>): string {
  const baseUrl = new URL(base.endsWith("/") ? base : base + "/");
  const url = new URL(path.startsWith("/") ? path.slice(1) : path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function authHeaders(apiKey: string | null): Record<string, string> {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

async function parseErrorBody(res: Response): Promise<{ error?: { code?: string; message?: string } }> {
  try {
    return (await res.json()) as { error?: { code?: string; message?: string } };
  } catch {
    return {};
  }
}

export function createHttpClient(cfg: HttpClientConfig): HttpClient {
  // Strip trailing slashes once at construction so every buildUrl() call
  // receives a clean base; the URL constructor preserves extra slashes otherwise.
  const platformUrl = cfg.platformUrl.replace(/\/+$/, "");
  const { apiKey, timeout, verbose } = cfg;

  // Fail fast with an actionable message when no platform URL is configured,
  // rather than letting `new URL('')` throw a cryptic "Invalid URL" error.
  if (!platformUrl) {
    throw new CliError(
      "No platform URL configured. Run `op profile add` or set the OP_PLATFORM_URL environment variable.",
      EXIT.GENERAL,
    );
  }

  if (cfg.insecureTls) {
    // NODE_TLS_REJECT_UNAUTHORIZED is a process-level flag in Node.js — there is no
    // per-request TLS bypass in native fetch. This intentionally affects all HTTPS
    // connections for the lifetime of this process, not just calls to platformUrl.
    // Bun handles this differently via its own TLS options.
    process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    console.warn(
      "Warning: TLS verification disabled for ALL connections in this session " +
      "(including third-party URLs). Only use --insecure-tls for development."
    );
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, unknown>,
  ): Promise<T> {
    const url = buildUrl(platformUrl, path, query);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    const headers: Record<string, string> = {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(apiKey),
    };

    if (verbose) {
      process.stderr.write(
        `[verbose] ${method} ${url}\n` +
          (apiKey ? `  Authorization: Bearer op_live_[redacted]\n` : ""),
      );
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new CliError(
          `Request timed out after ${timeout}ms.`,
          EXIT.NETWORK,
        );
      }
      throw new CliError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        EXIT.NETWORK,
        err instanceof Error ? err : undefined,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const errBody = await parseErrorBody(res);
      const retryAfter = res.headers.get("Retry-After");
      if (verbose) {
        process.stderr.write(`[verbose] HTTP ${res.status}: ${JSON.stringify(errBody)}\n`);
        if (retryAfter) {
          process.stderr.write(`[verbose] Retry-After: ${retryAfter}\n`);
        }
      }
      throw httpErrorToCliError(res.status, errBody, verbose, retryAfter);
    }

    if (res.status === 204) {
      return undefined as T;
    }
    return res.json() as Promise<T>;
  }

  return {
    get<T>(path: string, query?: Record<string, unknown>): Promise<T> {
      return request<T>("GET", path, undefined, query);
    },

    post<T>(path: string, body?: unknown): Promise<T> {
      return request<T>("POST", path, body ?? {});
    },

    patch<T>(path: string, body: unknown): Promise<T> {
      return request<T>("PATCH", path, body);
    },

    put<T>(path: string, body: unknown): Promise<T> {
      return request<T>("PUT", path, body);
    },

    async delete(path: string): Promise<void> {
      await request<void>("DELETE", path);
    },

    async postMultipart<T>(path: string, form: FormData): Promise<T> {
      const url = buildUrl(platformUrl, path);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);

      // Don't set Content-Type — fetch sets it with the correct boundary for multipart
      const headers: Record<string, string> = { ...authHeaders(apiKey) };

      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body: form, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === "AbortError") {
          throw new CliError(
            `Upload timed out after ${timeout}ms.`,
            EXIT.NETWORK,
          );
        }
        throw new CliError(
          `Network error: ${err instanceof Error ? err.message : String(err)}`,
          EXIT.NETWORK,
          err instanceof Error ? err : undefined,
        );
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        const errBody = await parseErrorBody(res);
        const retryAfter = res.headers.get("Retry-After");
        throw httpErrorToCliError(res.status, errBody, verbose, retryAfter);
      }
      return res.json() as Promise<T>;
    },

    async *stream(path: string, query?: Record<string, unknown>, signal?: AbortSignal): AsyncIterable<string> {
      const url = buildUrl(platformUrl, path, query);
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        ...authHeaders(apiKey),
      };

      // Connection timeout: abort if the initial connection is not established
      // within the configured timeout. Once connected, the caller controls
      // lifetime via the provided signal (e.g. Ctrl+C for SSE tailing).
      const connController = new AbortController();
      const connTimer = setTimeout(() => connController.abort(), timeout);

      // Forward caller's abort to our controller so a single signal covers both
      const onCallerAbort = (): void => connController.abort();
      if (signal) {
        if (signal.aborted) {
          connController.abort();
        } else {
          signal.addEventListener("abort", onCallerAbort, { once: true });
        }
      }

      let res: Response;
      try {
        res = await fetch(url, { headers, signal: connController.signal });
      } catch (err) {
        clearTimeout(connTimer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
        if (err instanceof Error && err.name === "AbortError") {
          // If the caller's signal was aborted, it's a user cancellation — re-throw as-is
          if (signal?.aborted) throw err;
          throw new CliError(
            `Stream connection timed out after ${timeout}ms.`,
            EXIT.NETWORK,
          );
        }
        throw new CliError(
          `Network error: ${err instanceof Error ? err.message : String(err)}`,
          EXIT.NETWORK,
          err instanceof Error ? err : undefined,
        );
      } finally {
        clearTimeout(connTimer);
        if (signal) signal.removeEventListener("abort", onCallerAbort);
      }
      if (!res.ok) {
        const errBody = await parseErrorBody(res);
        const retryAfter = res.headers.get("Retry-After");
        throw httpErrorToCliError(res.status, errBody, verbose, retryAfter);
      }
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          yield decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}
