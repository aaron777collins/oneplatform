import Docker from "dockerode";
import type {
  ContainerInfo,
  ContainerInspectInfo,
  ImageInfo,
  NetworkInspectInfo,
  VolumeInspectInfo,
  ContainerStats as DockerodeContainerStats,
} from "dockerode";
import {
  ContainerNotFoundError,
  ContainerRunningError,
  ImageNotFoundError,
} from "../errors.js";
import type { ContainerAction } from "../types.js";

// ---------------------------------------------------------------------------
// Docker connectivity.
//
// Two transports are supported:
//   1. Unix socket  — DOCKER_SOCKET (default /var/run/docker.sock)
//   2. TCP          — DOCKER_HOST (e.g. tcp://docker-host:2375)
//
// The client is created lazily and a single instance is reused. Connection
// failures are NOT thrown at construction time — the service must start even
// when no Docker socket is mounted (it returns 503 for Docker operations).
// ---------------------------------------------------------------------------

let client: Docker | null = null;

export function getDocker(): Docker {
  if (client !== null) return client;

  const dockerHost = process.env["DOCKER_HOST"];
  if (dockerHost !== undefined && dockerHost.trim() !== "") {
    const url = new URL(
      dockerHost.startsWith("tcp://")
        ? dockerHost.replace(/^tcp:\/\//, "http://")
        : dockerHost,
    );
    client = new Docker({
      host: url.hostname,
      port: url.port === "" ? 2375 : Number(url.port),
      protocol: url.protocol === "https:" ? "https" : "http",
    });
    return client;
  }

  const socketPath = process.env["DOCKER_SOCKET"] ?? "/var/run/docker.sock";
  client = new Docker({ socketPath });
  return client;
}

// Resets the cached client. Test-only hook so mocks can be injected.
export function __setDockerClient(c: Docker | null): void {
  client = c;
}

// ---------------------------------------------------------------------------
// Container operations
// ---------------------------------------------------------------------------

export async function listContainers(all = true): Promise<ContainerInfo[]> {
  return getDocker().listContainers({ all });
}

export async function getContainer(id: string): Promise<ContainerInspectInfo> {
  try {
    return await getDocker().getContainer(id).inspect();
  } catch (err) {
    if (isNotFound(err)) throw new ContainerNotFoundError(id);
    throw err;
  }
}

export async function getContainerLogs(
  id: string,
  opts: { tail?: number; since?: number } = {},
): Promise<string> {
  try {
    const buffer = await getDocker().getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 100,
      ...(opts.since !== undefined ? { since: opts.since } : {}),
      timestamps: true,
      follow: false,
    });
    // dockerode types logs() as returning a stream when follow is unset, but
    // with follow:false it resolves to a Buffer. Normalise to a string.
    return demuxLogBuffer(buffer as unknown as Buffer);
  } catch (err) {
    if (isNotFound(err)) throw new ContainerNotFoundError(id);
    throw err;
  }
}

export async function getContainerStats(
  id: string,
): Promise<DockerodeContainerStats> {
  try {
    // stream:false returns a single stats snapshot rather than a stream.
    return (await getDocker()
      .getContainer(id)
      .stats({ stream: false })) as unknown as DockerodeContainerStats;
  } catch (err) {
    if (isNotFound(err)) throw new ContainerNotFoundError(id);
    throw err;
  }
}

export async function containerAction(
  id: string,
  action: ContainerAction,
  opts: { timeoutSeconds?: number; force?: boolean } = {},
): Promise<void> {
  const container = getDocker().getContainer(id);
  try {
    switch (action) {
      case "start":
        await container.start();
        return;
      case "stop":
        await container.stop(
          opts.timeoutSeconds !== undefined ? { t: opts.timeoutSeconds } : {},
        );
        return;
      case "restart":
        await container.restart(
          opts.timeoutSeconds !== undefined ? { t: opts.timeoutSeconds } : {},
        );
        return;
      case "remove":
        if (opts.force !== true) {
          const info = await container.inspect();
          if (info.State.Running) throw new ContainerRunningError(id);
        }
        await container.remove({ force: opts.force ?? false });
        return;
    }
  } catch (err) {
    if (err instanceof ContainerRunningError) throw err;
    if (isNotFound(err)) throw new ContainerNotFoundError(id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Image / network / volume operations
// ---------------------------------------------------------------------------

export async function listImages(): Promise<ImageInfo[]> {
  return getDocker().listImages();
}

export async function removeImage(id: string): Promise<void> {
  try {
    await getDocker().getImage(id).remove();
  } catch (err) {
    if (isNotFound(err)) throw new ImageNotFoundError(id);
    throw err;
  }
}

export async function listNetworks(): Promise<NetworkInspectInfo[]> {
  return getDocker().listNetworks() as Promise<NetworkInspectInfo[]>;
}

export async function listVolumes(): Promise<VolumeInspectInfo[]> {
  const result = await getDocker().listVolumes();
  return result.Volumes ?? [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: unknown }).statusCode === 404
  );
}

// Docker multiplexes stdout/stderr into a single stream with an 8-byte header
// per frame: [STREAM_TYPE, 0, 0, 0, SIZE(4 bytes BE)]. When a container is
// created with a TTY there is no header and the payload is raw. We detect the
// framed format and strip headers; otherwise we return the buffer as-is.
function demuxLogBuffer(buffer: Buffer): string {
  if (buffer.length === 0) return "";

  const lines: string[] = [];
  let offset = 0;
  let framed = false;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    // Valid frame stream types are 0 (stdin), 1 (stdout), 2 (stderr).
    if (streamType !== 0 && streamType !== 1 && streamType !== 2) break;
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) break;
    const payload = buffer.subarray(offset + 8, offset + 8 + size);
    lines.push(payload.toString("utf8"));
    offset += 8 + size;
    framed = true;
  }

  if (!framed) {
    return buffer.toString("utf8");
  }
  return lines.join("");
}
