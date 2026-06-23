import type { ContainerPort } from "../../types/docker.js";

export function PortList({ ports }: { ports: ContainerPort[] }): JSX.Element {
  if (ports.length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <span>
      {ports.map((p, i) => (
        <span className="port-chip" key={`${p.privatePort}-${p.type}-${i}`}>
          {p.publicPort !== null
            ? `${p.publicPort}→${p.privatePort}/${p.type}`
            : `${p.privatePort}/${p.type}`}
        </span>
      ))}
    </span>
  );
}
