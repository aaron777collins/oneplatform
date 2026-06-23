import { useState } from "react";
import { useContainer } from "../../hooks/useContainer.js";
import { StatusBadge } from "../shared/StatusBadge.js";
import { OverviewTab } from "./OverviewTab.js";
import { LogsTab } from "./LogsTab.js";
import { StatsTab } from "./StatsTab.js";
import { ContainerActionBar } from "./ContainerActionBar.js";

type DetailTab = "overview" | "logs" | "stats";

interface ContainerDetailPanelProps {
  containerId: string;
  onClose: () => void;
  onChanged: () => void;
}

export function ContainerDetailPanel({
  containerId,
  onClose,
  onChanged,
}: ContainerDetailPanelProps): JSX.Element {
  const [tab, setTab] = useState<DetailTab>("overview");
  const { data: container, error, loading, refresh } = useContainer(containerId);

  return (
    <>
      <div className="detail-overlay" onClick={onClose} />
      <aside className="detail-panel">
        <div className="detail-header">
          <h3>{container?.name ?? "Container"}</h3>
          {container !== null && <StatusBadge status={container.status} />}
          <button className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="tabs">
          {(["overview", "logs", "stats"] as DetailTab[]).map((t) => (
            <button
              key={t}
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="tab-body">
          {error !== null && container === null && (
            <div className="error-state">{error}</div>
          )}
          {loading && container === null && (
            <div className="muted">Loading…</div>
          )}
          {tab === "overview" && container !== null && (
            <OverviewTab container={container} />
          )}
          {tab === "logs" && <LogsTab containerId={containerId} />}
          {tab === "stats" && <StatsTab containerId={containerId} />}
        </div>

        {container !== null && (
          <ContainerActionBar
            containerId={container.id}
            containerName={container.name}
            status={container.status}
            onActionComplete={() => {
              refresh();
              onChanged();
            }}
          />
        )}
      </aside>
    </>
  );
}
