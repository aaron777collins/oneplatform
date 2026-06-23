import type { NetworkInspectInfo } from "dockerode";
import type { DockerNetwork } from "../types.js";

export function transformNetwork(net: NetworkInspectInfo): DockerNetwork {
  const config = (net.IPAM?.Config ?? []).map((cfg) => ({
    subnet: cfg.Subnet ?? "",
    gateway: cfg.Gateway ?? "",
  }));

  const containers: DockerNetwork["containers"] = {};
  for (const [id, c] of Object.entries(net.Containers ?? {})) {
    containers[id] = {
      name: c.Name ?? "",
      ipAddress: c.IPv4Address ?? c.IPv6Address ?? "",
    };
  }

  return {
    id: net.Id,
    name: net.Name,
    driver: net.Driver ?? "",
    scope: net.Scope ?? "",
    ipam: {
      driver: net.IPAM?.Driver ?? "",
      config,
    },
    internal: net.Internal ?? false,
    attachable: net.Attachable ?? false,
    containers,
    createdAt: net.Created ?? "",
  };
}
