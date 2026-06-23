import { useVolumes } from "../../hooks/useVolumes.js";
import { formatBytes } from "../shared/ByteSize.js";
import { RefreshButton } from "../shared/RefreshButton.js";

export function VolumeListView(): JSX.Element {
  const { data, error, loading, refresh } = useVolumes();

  return (
    <div>
      <div className="fleet-toolbar">
        <h2>Volumes</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {error !== null && data === null ? (
        <div className="error-state">{error}</div>
      ) : data === null ? (
        <div className="muted">Loading volumes…</div>
      ) : data.length === 0 ? (
        <div className="empty-state">No volumes found.</div>
      ) : (
        <table className="fleet-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Driver</th>
              <th>Mountpoint</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {data.map((vol) => (
              <tr key={vol.name}>
                <td>
                  <strong className="mono">{vol.name}</strong>
                </td>
                <td>{vol.driver}</td>
                <td className="mono muted">{vol.mountpoint}</td>
                <td className="mono">
                  {vol.usageData !== null ? formatBytes(vol.usageData.size) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
