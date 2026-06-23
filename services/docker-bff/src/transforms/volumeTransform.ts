import type { VolumeInspectInfo } from "dockerode";
import type { DockerVolume } from "../types.js";

export function transformVolume(vol: VolumeInspectInfo): DockerVolume {
  const usage = vol.UsageData ?? null;
  return {
    name: vol.Name,
    driver: vol.Driver,
    mountpoint: vol.Mountpoint,
    scope: vol.Scope ?? "local",
    labels: vol.Labels ?? {},
    options: vol.Options ?? {},
    usageData:
      usage && usage.Size >= 0
        ? { size: usage.Size, refCount: usage.RefCount }
        : null,
    // CreatedAt is present in the daemon response but absent from dockerode's
    // VolumeInspectInfo type, so read it through a narrow cast.
    createdAt: (vol as unknown as { CreatedAt?: string }).CreatedAt ?? "",
  };
}
