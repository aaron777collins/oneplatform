import type {
  ContainerInfo,
  ContainerInspectInfo,
  ContainerStats as DockerodeContainerStats,
} from "dockerode";
import type {
  ContainerMount,
  ContainerNetworkSettings,
  ContainerPort,
  ContainerStats,
  ContainerStatus,
  DockerContainer,
  DockerContainerDetail,
} from "../types.js";

// Maps Docker's `State` string (from list) to our normalised status enum.
function normaliseStatus(state: string): ContainerStatus {
  switch (state.toLowerCase()) {
    case "running":
      return "running";
    case "exited":
      return "exited";
    case "paused":
      return "paused";
    case "created":
      return "created";
    case "restarting":
      return "restarting";
    case "dead":
      return "dead";
    default:
      return "exited";
  }
}

function stripLeadingSlash(name: string): string {
  return name.startsWith("/") ? name.slice(1) : name;
}

function mapPorts(ports: ContainerInfo["Ports"] | undefined): ContainerPort[] {
  if (ports === undefined) return [];
  return ports.map((p) => ({
    privatePort: p.PrivatePort,
    publicPort: p.PublicPort ?? null,
    type: (p.Type ?? "tcp") as ContainerPort["type"],
    ip: p.IP ?? null,
  }));
}

// Transforms one entry from `GET /containers/json` into a DockerContainer.
export function transformContainerListItem(c: ContainerInfo): DockerContainer {
  const name = c.Names.length > 0 ? stripLeadingSlash(c.Names[0]!) : c.Id.slice(0, 12);
  const networks = c.NetworkSettings?.Networks
    ? Object.keys(c.NetworkSettings.Networks)
    : [];

  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name,
    image: c.Image,
    imageId: c.ImageID,
    status: normaliseStatus(c.State),
    statusText: c.Status,
    ports: mapPorts(c.Ports),
    createdAt: new Date(c.Created * 1000).toISOString(),
    startedAt: null,
    labels: c.Labels ?? {},
    networks,
  };
}

function parseEnvVars(env: string[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env) return out;
  for (const entry of env) {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      out[entry] = "";
    } else {
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  }
  return out;
}

function mapMounts(
  mounts: ContainerInspectInfo["Mounts"] | undefined,
): ContainerMount[] {
  if (!mounts) return [];
  return mounts.map((m) => ({
    type: (m.Type ?? "volume") as ContainerMount["type"],
    source: m.Source ?? "",
    destination: m.Destination,
    mode: m.Mode ?? "",
    rw: m.RW,
  }));
}

function mapNetworkSettings(
  settings: ContainerInspectInfo["NetworkSettings"] | undefined,
): ContainerNetworkSettings {
  const networks: ContainerNetworkSettings["networks"] = {};
  const raw = settings?.Networks ?? {};
  for (const [name, net] of Object.entries(raw)) {
    networks[name] = {
      networkId: net.NetworkID ?? "",
      ipAddress: net.IPAddress ?? "",
      gateway: net.Gateway ?? "",
      macAddress: net.MacAddress ?? "",
    };
  }
  return { networks };
}

function inspectStatus(state: ContainerInspectInfo["State"]): ContainerStatus {
  if (state.Running) return "running";
  if (state.Paused) return "paused";
  if (state.Restarting) return "restarting";
  if (state.Dead) return "dead";
  if (state.Status) return normaliseStatus(state.Status);
  return "exited";
}

// Transforms `GET /containers/{id}/json` into a DockerContainerDetail.
export function transformContainerInspect(
  c: ContainerInspectInfo,
): DockerContainerDetail {
  const name = stripLeadingSlash(c.Name);
  const config = c.Config ?? ({} as ContainerInspectInfo["Config"]);
  // SizeRootFs is only present when the daemon was queried with size=true; it is
  // not in dockerode's published type, so read it through a narrow cast.
  const sizeRootFs = (c as unknown as { SizeRootFs?: number }).SizeRootFs;
  const networkSettings = mapNetworkSettings(c.NetworkSettings);
  const ports: ContainerPort[] = [];
  const portBindings = c.NetworkSettings?.Ports ?? {};
  for (const [key, bindings] of Object.entries(portBindings)) {
    const [portStr, proto] = key.split("/");
    const privatePort = Number(portStr);
    if (Number.isNaN(privatePort)) continue;
    if (bindings && bindings.length > 0) {
      for (const b of bindings) {
        ports.push({
          privatePort,
          publicPort: b.HostPort ? Number(b.HostPort) : null,
          type: (proto ?? "tcp") as ContainerPort["type"],
          ip: b.HostIp ?? null,
        });
      }
    } else {
      ports.push({
        privatePort,
        publicPort: null,
        type: (proto ?? "tcp") as ContainerPort["type"],
        ip: null,
      });
    }
  }

  return {
    id: c.Id,
    shortId: c.Id.slice(0, 12),
    name,
    image: config.Image ?? c.Image,
    imageId: c.Image,
    status: inspectStatus(c.State),
    statusText: c.State.Status ?? "",
    ports,
    createdAt: new Date(c.Created).toISOString(),
    startedAt: c.State.StartedAt && c.State.StartedAt !== "0001-01-01T00:00:00Z"
      ? new Date(c.State.StartedAt).toISOString()
      : null,
    labels: config.Labels ?? {},
    networks: Object.keys(networkSettings.networks),
    hostname: config.Hostname ?? "",
    entrypoint: normaliseStringArray(config.Entrypoint),
    command: normaliseStringArray(config.Cmd),
    envVars: parseEnvVars(config.Env),
    mounts: mapMounts(c.Mounts),
    restartPolicy: c.HostConfig?.RestartPolicy?.Name ?? "no",
    networkSettings,
    platform: c.Platform ?? "",
    sizeRootFs: typeof sizeRootFs === "number" ? sizeRootFs : null,
  };
}

function normaliseStringArray(value: string | string[] | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

// Computes a ContainerStats snapshot from a raw Docker stats object.
// Docker reports cumulative CPU ticks, not a percentage, so we derive the
// percentage from the delta against the previous reading (precpu_stats).
export function transformStats(
  raw: DockerodeContainerStats,
  ts: string = new Date().toISOString(),
): ContainerStats {
  const cpuDelta =
    raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const systemDelta =
    (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const numCpus =
    raw.cpu_stats.online_cpus ??
    raw.cpu_stats.cpu_usage.percpu_usage?.length ??
    1;

  let cpuPercent = 0;
  if (systemDelta > 0 && cpuDelta > 0) {
    cpuPercent = (cpuDelta / systemDelta) * numCpus * 100;
  }

  const memoryUsageBytes = raw.memory_stats.usage ?? 0;
  const memoryLimitBytes = raw.memory_stats.limit ?? 0;
  const memoryPercent =
    memoryLimitBytes > 0 ? (memoryUsageBytes / memoryLimitBytes) * 100 : 0;

  let blockReadBytes = 0;
  let blockWriteBytes = 0;
  const ioEntries = raw.blkio_stats?.io_service_bytes_recursive ?? [];
  for (const entry of ioEntries) {
    if (entry.op === "Read" || entry.op === "read") blockReadBytes += entry.value;
    if (entry.op === "Write" || entry.op === "write") blockWriteBytes += entry.value;
  }

  let netRxBytes = 0;
  let netTxBytes = 0;
  for (const net of Object.values(raw.networks ?? {})) {
    netRxBytes += net.rx_bytes ?? 0;
    netTxBytes += net.tx_bytes ?? 0;
  }

  return {
    cpuPercent: round2(cpuPercent),
    memoryUsageBytes,
    memoryLimitBytes,
    memoryPercent: round2(memoryPercent),
    blockReadBytes,
    blockWriteBytes,
    netRxBytes,
    netTxBytes,
    ts,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
