import { useImages } from "../../hooks/useImages.js";
import { formatBytes } from "../shared/ByteSize.js";
import { RefreshButton } from "../shared/RefreshButton.js";

export function ImageListView(): JSX.Element {
  const { data, error, loading, refresh } = useImages();

  return (
    <div>
      <div className="fleet-toolbar">
        <h2>Images</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {error !== null && data === null ? (
        <div className="error-state">{error}</div>
      ) : data === null ? (
        <div className="muted">Loading images…</div>
      ) : data.length === 0 ? (
        <div className="empty-state">No images found.</div>
      ) : (
        <table className="fleet-table">
          <thead>
            <tr>
              <th>Tags</th>
              <th>ID</th>
              <th>Size</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {data.map((img) => (
              <tr key={img.id}>
                <td>
                  {img.repoTags.length > 0 ? (
                    img.repoTags.map((t) => (
                      <div className="mono" key={t}>
                        {t}
                      </div>
                    ))
                  ) : (
                    <span className="muted">&lt;none&gt;</span>
                  )}
                </td>
                <td className="mono">{img.shortId}</td>
                <td className="mono">{formatBytes(img.sizeBytes)}</td>
                <td className="muted">{new Date(img.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
