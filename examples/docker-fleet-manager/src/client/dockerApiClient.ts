import type {
  ContainerAction,
  DockerApiError,
  DockerContainer,
  DockerContainerDetail,
  DockerImage,
  DockerNetwork,
  DockerVolume,
} from "../types/docker.js";

// ---------------------------------------------------------------------------
// Thin fetch wrapper for the Docker BFF proxy.
//
// All calls go to `/bff/docker/...` (same origin) — the CSP only permits
// same-origin fetch, and the App Service proxies these to the Docker BFF
// Sidecar after validating the session and the admin/devops role.
//
// Every response follows the OnePlatform envelope:
//   success: { data: T }
//   error:   { error: { code, message } }
// ---------------------------------------------------------------------------

const BASE = "/bff/docker";

export class DockerApiClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DockerApiClientError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new DockerApiClientError(
      "NETWORK_ERROR",
      "Could not reach the Docker management service.",
      0,
    );
  }

  // 204 No Content — successful action with no body.
  if (res.status === 204) {
    return undefined as T;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const err = (body as { error?: DockerApiError } | null)?.error;
    throw new DockerApiClientError(
      err?.code ?? "UNKNOWN",
      err?.message ?? `Request failed with status ${res.status}.`,
      res.status,
    );
  }

  return (body as { data: T }).data;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function fetchContainers(opts?: {
  status?: string;
  name?: string;
  signal?: AbortSignal;
}): Promise<DockerContainer[]> {
  const params = new URLSearchParams();
  if (opts?.status !== undefined && opts.status !== "all") {
    params.set("status", opts.status);
  }
  if (opts?.name !== undefined && opts.name !== "") {
    params.set("name", opts.name);
  }
  const qs = params.toString();
  return request<DockerContainer[]>(
    `/containers${qs ? `?${qs}` : ""}`,
    opts?.signal ? { signal: opts.signal } : undefined,
  );
}

export function fetchContainer(
  id: string,
  signal?: AbortSignal,
): Promise<DockerContainerDetail> {
  return request<DockerContainerDetail>(
    `/containers/${encodeURIComponent(id)}`,
    signal ? { signal } : undefined,
  );
}

export function containerAction(
  id: string,
  action: ContainerAction,
  opts?: { timeoutSeconds?: number; force?: boolean },
): Promise<void> {
  if (action === "remove") {
    const force = opts?.force === true ? "?force=true" : "";
    return request<void>(`/containers/${encodeURIComponent(id)}${force}`, {
      method: "DELETE",
    });
  }
  const body =
    opts?.timeoutSeconds !== undefined
      ? JSON.stringify({ timeoutSeconds: opts.timeoutSeconds })
      : undefined;
  return request<void>(`/containers/${encodeURIComponent(id)}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body } : {}),
  });
}

// SSE endpoints — the caller manages the EventSource lifecycle.
export function containerLogsUrl(id: string, tail = 100): string {
  return `${BASE}/containers/${encodeURIComponent(id)}/logs?tail=${tail}`;
}

export function containerStatsUrl(id: string): string {
  return `${BASE}/containers/${encodeURIComponent(id)}/stats`;
}

// ---------------------------------------------------------------------------
// Images / networks / volumes
// ---------------------------------------------------------------------------

export function fetchImages(signal?: AbortSignal): Promise<DockerImage[]> {
  return request<DockerImage[]>("/images", signal ? { signal } : undefined);
}

export function removeImage(id: string): Promise<void> {
  return request<void>(`/images/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function fetchNetworks(signal?: AbortSignal): Promise<DockerNetwork[]> {
  return request<DockerNetwork[]>("/networks", signal ? { signal } : undefined);
}

export function fetchVolumes(signal?: AbortSignal): Promise<DockerVolume[]> {
  return request<DockerVolume[]>("/volumes", signal ? { signal } : undefined);
}
