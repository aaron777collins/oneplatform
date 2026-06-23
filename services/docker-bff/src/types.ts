// Typed response shapes returned by the Docker BFF Sidecar.
//
// These mirror the frontend `examples/docker-fleet-manager/src/types/docker.ts`
// interfaces. The sidecar transforms raw Docker Engine API JSON into these
// clean shapes so the frontend never sees the daemon's idiosyncratic format.

export type ContainerStatus =
  | "running"
  | "exited"
  | "paused"
  | "created"
  | "restarting"
  | "dead";

export interface ContainerPort {
  privatePort: number;
  publicPort: number | null;
  type: "tcp" | "udp" | "sctp";
  ip: string | null;
}

export interface DockerContainer {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string;
  status: ContainerStatus;
  statusText: string;
  ports: ContainerPort[];
  createdAt: string;
  startedAt: string | null;
  labels: Record<string, string>;
  networks: string[];
}

export interface ContainerMount {
  type: "bind" | "volume" | "tmpfs";
  source: string;
  destination: string;
  mode: string;
  rw: boolean;
}

export interface ContainerNetworkSettings {
  networks: Record<
    string,
    {
      networkId: string;
      ipAddress: string;
      gateway: string;
      macAddress: string;
    }
  >;
}

export interface DockerContainerDetail extends DockerContainer {
  hostname: string;
  entrypoint: string[];
  command: string[];
  envVars: Record<string, string>;
  mounts: ContainerMount[];
  restartPolicy: string;
  networkSettings: ContainerNetworkSettings;
  platform: string;
  sizeRootFs: number | null;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  netRxBytes: number;
  netTxBytes: number;
  ts: string;
}

export interface DockerImage {
  id: string;
  shortId: string;
  repoTags: string[];
  repoDigests: string[];
  sizeBytes: number;
  virtualSizeBytes: number;
  createdAt: string;
  labels: Record<string, string>;
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  ipam: {
    driver: string;
    config: { subnet: string; gateway: string }[];
  };
  internal: boolean;
  attachable: boolean;
  containers: Record<string, { name: string; ipAddress: string }>;
  createdAt: string;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  scope: string;
  labels: Record<string, string>;
  options: Record<string, string>;
  usageData: { size: number; refCount: number } | null;
  createdAt: string;
}

export type ContainerAction = "start" | "stop" | "restart" | "remove";
