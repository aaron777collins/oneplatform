import { describe, it, expect } from "vitest";
import type {
  ContainerInfo,
  ContainerInspectInfo,
  ContainerStats as DockerodeContainerStats,
  ImageInfo,
  NetworkInspectInfo,
  VolumeInspectInfo,
} from "dockerode";
import {
  transformContainerListItem,
  transformContainerInspect,
  transformStats,
} from "../transforms/containerTransform.js";
import { transformImage } from "../transforms/imageTransform.js";
import { transformNetwork } from "../transforms/networkTransform.js";
import { transformVolume } from "../transforms/volumeTransform.js";

describe("transformContainerListItem", () => {
  it("maps a running container with ports and strips the leading slash from the name", () => {
    const raw = {
      Id: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
      Names: ["/web-server"],
      Image: "nginx:latest",
      ImageID: "sha256:deadbeef",
      State: "running",
      Status: "Up 3 hours",
      Created: 1_700_000_000,
      Ports: [
        { PrivatePort: 80, PublicPort: 8080, Type: "tcp", IP: "0.0.0.0" },
      ],
      Labels: { app: "web" },
      NetworkSettings: { Networks: { bridge: {} } },
    } as unknown as ContainerInfo;

    const result = transformContainerListItem(raw);

    expect(result.shortId).toBe("abcdef012345");
    expect(result.name).toBe("web-server");
    expect(result.status).toBe("running");
    expect(result.statusText).toBe("Up 3 hours");
    expect(result.ports).toEqual([
      { privatePort: 80, publicPort: 8080, type: "tcp", ip: "0.0.0.0" },
    ]);
    expect(result.networks).toEqual(["bridge"]);
    expect(result.createdAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });

  it("handles missing ports, labels, and networks", () => {
    const raw = {
      Id: "0123456789ab0123456789ab0123456789ab0123456789ab0123456789ab0123",
      Names: ["/lonely"],
      Image: "alpine",
      ImageID: "sha256:abc",
      State: "exited",
      Status: "Exited (0) 5 minutes ago",
      Created: 1_700_000_000,
    } as unknown as ContainerInfo;

    const result = transformContainerListItem(raw);
    expect(result.ports).toEqual([]);
    expect(result.labels).toEqual({});
    expect(result.networks).toEqual([]);
    expect(result.status).toBe("exited");
  });

  it("falls back to short id when there are no names", () => {
    const raw = {
      Id: "feedface0000feedface0000feedface0000feedface0000feedface00001111",
      Names: [],
      Image: "busybox",
      ImageID: "sha256:x",
      State: "created",
      Status: "Created",
      Created: 1_700_000_000,
    } as unknown as ContainerInfo;

    const result = transformContainerListItem(raw);
    expect(result.name).toBe("feedface0000");
  });
});

describe("transformContainerInspect", () => {
  it("parses env vars, mounts, restart policy, and network settings", () => {
    const raw = {
      Id: "abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abcd",
      Name: "/api",
      Image: "sha256:imageid",
      Created: "2026-06-22T10:00:00.000Z",
      Platform: "linux",
      SizeRootFs: 12345,
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        StartedAt: "2026-06-22T10:01:00.000Z",
      },
      Config: {
        Hostname: "api-host",
        Image: "myorg/api:v1",
        Entrypoint: ["/entrypoint.sh"],
        Cmd: ["node", "server.js"],
        Env: ["NODE_ENV=production", "PORT=8080", "BARE"],
        Labels: { tier: "backend" },
      },
      HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
      Mounts: [
        {
          Type: "volume",
          Source: "/var/lib/docker/volumes/data",
          Destination: "/data",
          Mode: "rw",
          RW: true,
        },
      ],
      NetworkSettings: {
        Ports: {
          "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }],
          "9090/tcp": null,
        },
        Networks: {
          bridge: {
            NetworkID: "netid",
            IPAddress: "172.17.0.2",
            Gateway: "172.17.0.1",
            MacAddress: "02:42:ac:11:00:02",
          },
        },
      },
    } as unknown as ContainerInspectInfo;

    const result = transformContainerInspect(raw);

    expect(result.name).toBe("api");
    expect(result.image).toBe("myorg/api:v1");
    expect(result.status).toBe("running");
    expect(result.envVars).toEqual({
      NODE_ENV: "production",
      PORT: "8080",
      BARE: "",
    });
    expect(result.entrypoint).toEqual(["/entrypoint.sh"]);
    expect(result.command).toEqual(["node", "server.js"]);
    expect(result.restartPolicy).toBe("unless-stopped");
    expect(result.mounts).toHaveLength(1);
    expect(result.mounts[0]!.destination).toBe("/data");
    expect(result.networkSettings.networks["bridge"]!.ipAddress).toBe("172.17.0.2");
    expect(result.startedAt).toBe(new Date("2026-06-22T10:01:00.000Z").toISOString());
    expect(result.sizeRootFs).toBe(12345);
    // Bound port plus an exposed-but-unbound port.
    expect(result.ports).toEqual([
      { privatePort: 8080, publicPort: 8080, type: "tcp", ip: "0.0.0.0" },
      { privatePort: 9090, publicPort: null, type: "tcp", ip: null },
    ]);
  });

  it("reports a null startedAt for the zero timestamp", () => {
    const raw = {
      Id: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      Name: "/stopped",
      Image: "sha256:x",
      Created: "2026-06-22T10:00:00.000Z",
      State: {
        Status: "exited",
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        StartedAt: "0001-01-01T00:00:00Z",
      },
      Config: {},
      HostConfig: {},
      NetworkSettings: {},
    } as unknown as ContainerInspectInfo;

    const result = transformContainerInspect(raw);
    expect(result.startedAt).toBeNull();
    expect(result.status).toBe("exited");
    expect(result.restartPolicy).toBe("no");
  });
});

describe("transformStats", () => {
  it("computes CPU and memory percentages from cumulative ticks", () => {
    const raw = {
      cpu_stats: {
        cpu_usage: { total_usage: 2_000_000, percpu_usage: [1, 1] },
        system_cpu_usage: 20_000_000,
        online_cpus: 2,
      },
      precpu_stats: {
        cpu_usage: { total_usage: 1_000_000 },
        system_cpu_usage: 10_000_000,
      },
      memory_stats: { usage: 134_217_728, limit: 536_870_912 },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: "Read", value: 0 },
          { op: "Write", value: 4096 },
        ],
      },
      networks: { eth0: { rx_bytes: 1024, tx_bytes: 512 } },
    } as unknown as DockerodeContainerStats;

    const result = transformStats(raw, "2026-06-22T10:00:01.000Z");

    // cpuDelta=1e6, systemDelta=1e7 -> 0.1 * 2 * 100 = 20%
    expect(result.cpuPercent).toBe(20);
    expect(result.memoryUsageBytes).toBe(134_217_728);
    expect(result.memoryPercent).toBe(25);
    expect(result.blockWriteBytes).toBe(4096);
    expect(result.netRxBytes).toBe(1024);
    expect(result.netTxBytes).toBe(512);
    expect(result.ts).toBe("2026-06-22T10:00:01.000Z");
  });

  it("returns 0% CPU when there is no system delta", () => {
    const raw = {
      cpu_stats: {
        cpu_usage: { total_usage: 1000 },
        system_cpu_usage: 0,
        online_cpus: 1,
      },
      precpu_stats: { cpu_usage: { total_usage: 0 }, system_cpu_usage: 0 },
      memory_stats: { usage: 0, limit: 0 },
    } as unknown as DockerodeContainerStats;

    const result = transformStats(raw);
    expect(result.cpuPercent).toBe(0);
    expect(result.memoryPercent).toBe(0);
  });
});

describe("transformImage", () => {
  it("computes shortId and filters dangling repo tags", () => {
    const raw = {
      Id: "sha256:1234567890abcdef1234567890abcdef",
      RepoTags: ["nginx:latest", "<none>:<none>"],
      RepoDigests: ["nginx@sha256:abc"],
      Size: 1000,
      VirtualSize: 2000,
      Created: 1_700_000_000,
      Labels: { maintainer: "x" },
    } as unknown as ImageInfo;

    const result = transformImage(raw);
    expect(result.shortId).toBe("1234567890ab");
    expect(result.repoTags).toEqual(["nginx:latest"]);
    expect(result.sizeBytes).toBe(1000);
  });
});

describe("transformNetwork", () => {
  it("maps IPAM config and connected containers", () => {
    const raw = {
      Id: "netid",
      Name: "mynet",
      Driver: "bridge",
      Scope: "local",
      Internal: false,
      Attachable: true,
      Created: "2026-06-22T10:00:00.000Z",
      IPAM: {
        Driver: "default",
        Config: [{ Subnet: "172.18.0.0/16", Gateway: "172.18.0.1" }],
      },
      Containers: {
        c1: { Name: "web", IPv4Address: "172.18.0.2/16" },
      },
    } as unknown as NetworkInspectInfo;

    const result = transformNetwork(raw);
    expect(result.ipam.config).toEqual([
      { subnet: "172.18.0.0/16", gateway: "172.18.0.1" },
    ]);
    expect(result.containers["c1"]!.ipAddress).toBe("172.18.0.2/16");
    expect(result.attachable).toBe(true);
  });
});

describe("transformVolume", () => {
  it("includes usage data when present", () => {
    const raw = {
      Name: "data",
      Driver: "local",
      Mountpoint: "/var/lib/docker/volumes/data/_data",
      Scope: "local",
      Labels: { app: "db" },
      Options: { type: "nfs" },
      CreatedAt: "2026-06-22T10:00:00.000Z",
      UsageData: { Size: 4096, RefCount: 1 },
    } as unknown as VolumeInspectInfo;

    const result = transformVolume(raw);
    expect(result.usageData).toEqual({ size: 4096, refCount: 1 });
    expect(result.options).toEqual({ type: "nfs" });
  });

  it("returns null usageData when Docker reports -1", () => {
    const raw = {
      Name: "data",
      Driver: "local",
      Mountpoint: "/x",
      Scope: "local",
      UsageData: { Size: -1, RefCount: -1 },
    } as unknown as VolumeInspectInfo;

    const result = transformVolume(raw);
    expect(result.usageData).toBeNull();
  });
});
