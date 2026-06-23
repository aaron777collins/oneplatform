import type { ContainerStatus } from "../../types/docker.js";

const MAP: Record<ContainerStatus, { cls: string; label: string }> = {
  running: { cls: "badge-green", label: "Running" },
  exited: { cls: "badge-red", label: "Exited" },
  paused: { cls: "badge-yellow", label: "Paused" },
  created: { cls: "badge-gray", label: "Created" },
  restarting: { cls: "badge-yellow", label: "Restarting" },
  dead: { cls: "badge-red", label: "Dead" },
};

export function StatusBadge({ status }: { status: ContainerStatus }): JSX.Element {
  const entry = MAP[status] ?? { cls: "badge-gray", label: status };
  return <span className={`badge ${entry.cls}`}>{entry.label}</span>;
}
