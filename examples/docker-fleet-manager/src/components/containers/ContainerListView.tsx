import { useState } from "react";
import { useContainers } from "../../hooks/useContainers.js";
import { ContainerToolbar } from "./ContainerToolbar.js";
import { ContainerTable } from "./ContainerTable.js";
import { ContainerDetailPanel } from "./ContainerDetailPanel.js";

export function ContainerListView(): JSX.Element {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, error, loading, refresh } = useContainers({
    status,
    name: search,
  });

  return (
    <div>
      <ContainerToolbar
        search={search}
        onSearch={setSearch}
        status={status}
        onStatus={setStatus}
        onRefresh={refresh}
        loading={loading}
      />

      {error !== null && data === null ? (
        <div className="error-state">{error}</div>
      ) : data === null ? (
        <div className="muted">Loading containers…</div>
      ) : (
        <ContainerTable containers={data} onRowClick={setSelectedId} />
      )}

      {selectedId !== null && (
        <ContainerDetailPanel
          containerId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
