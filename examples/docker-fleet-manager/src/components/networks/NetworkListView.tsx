import { useNetworks } from "../../hooks/useNetworks.js";
import { RefreshButton } from "../shared/RefreshButton.js";

export function NetworkListView(): JSX.Element {
  const { data, error, loading, refresh } = useNetworks();

  return (
    <div>
      <div className="fleet-toolbar">
        <h2>Networks</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {error !== null && data === null ? (
        <div className="error-state">{error}</div>
      ) : data === null ? (
        <div className="muted">Loading networks…</div>
      ) : data.length === 0 ? (
        <div className="empty-state">No networks found.</div>
      ) : (
        <table className="fleet-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Driver</th>
              <th>Scope</th>
              <th>Subnet</th>
              <th>Containers</th>
            </tr>
          </thead>
          <tbody>
            {data.map((net) => (
              <tr key={net.id}>
                <td>
                  <strong>{net.name}</strong>
                </td>
                <td>{net.driver}</td>
                <td className="muted">{net.scope}</td>
                <td className="mono">
                  {net.ipam.config.length > 0
                    ? net.ipam.config.map((c) => c.subnet).filter(Boolean).join(", ") || "—"
                    : "—"}
                </td>
                <td>{Object.keys(net.containers).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
