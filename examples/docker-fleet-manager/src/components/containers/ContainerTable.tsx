import { useMemo, useState } from "react";
import type { DockerContainer } from "../../types/docker.js";
import { StatusBadge } from "../shared/StatusBadge.js";
import { PortList } from "../shared/PortList.js";

type SortKey = "name" | "image" | "status" | "createdAt";
type SortDir = "asc" | "desc";

interface ContainerTableProps {
  containers: DockerContainer[];
  onRowClick: (id: string) => void;
}

const COLUMNS: { key: SortKey | null; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "image", label: "Image" },
  { key: "status", label: "Status" },
  { key: null, label: "Ports" },
  { key: "createdAt", label: "Created" },
];

export function ContainerTable({ containers, onRowClick }: ContainerTableProps): JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const sorted = useMemo(() => {
    const copy = [...containers];
    copy.sort((a, b) => {
      const av = String(a[sortKey]);
      const bv = String(b[sortKey]);
      const cmp = av.localeCompare(bv);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [containers, sortKey, sortDir]);

  function toggleSort(key: SortKey): void {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  if (containers.length === 0) {
    return <div className="empty-state">No containers match the current filter.</div>;
  }

  return (
    <table className="fleet-table">
      <thead>
        <tr>
          {COLUMNS.map((col) => (
            <th
              key={col.label}
              onClick={col.key !== null ? () => toggleSort(col.key as SortKey) : undefined}
            >
              {col.label}
              {col.key === sortKey ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((c) => (
          <tr key={c.id} onClick={() => onRowClick(c.id)}>
            <td>
              <strong>{c.name}</strong>
              <div className="muted mono" style={{ fontSize: 12 }}>
                {c.shortId}
              </div>
            </td>
            <td className="mono">{c.image}</td>
            <td>
              <StatusBadge status={c.status} />
              <div className="muted" style={{ fontSize: 12 }}>
                {c.statusText}
              </div>
            </td>
            <td>
              <PortList ports={c.ports} />
            </td>
            <td className="muted">{new Date(c.createdAt).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
