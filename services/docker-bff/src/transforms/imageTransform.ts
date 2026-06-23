import type { ImageInfo } from "dockerode";
import type { DockerImage } from "../types.js";

function shortImageId(id: string): string {
  // Image IDs are prefixed with the algorithm, e.g. "sha256:abcd...".
  const hash = id.includes(":") ? id.split(":")[1]! : id;
  return hash.slice(0, 12);
}

export function transformImage(img: ImageInfo): DockerImage {
  return {
    id: img.Id,
    shortId: shortImageId(img.Id),
    repoTags: (img.RepoTags ?? []).filter((t) => t !== "<none>:<none>"),
    repoDigests: img.RepoDigests ?? [],
    sizeBytes: img.Size,
    virtualSizeBytes: img.VirtualSize ?? img.Size,
    createdAt: new Date(img.Created * 1000).toISOString(),
    labels: img.Labels ?? {},
  };
}
