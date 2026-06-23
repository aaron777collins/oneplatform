import { RefreshButton } from "../shared/RefreshButton.js";

interface ContainerToolbarProps {
  search: string;
  onSearch: (value: string) => void;
  status: string;
  onStatus: (value: string) => void;
  onRefresh: () => void;
  loading: boolean;
}

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "exited", label: "Exited" },
  { value: "paused", label: "Paused" },
  { value: "created", label: "Created" },
];

export function ContainerToolbar({
  search,
  onSearch,
  status,
  onStatus,
  onRefresh,
  loading,
}: ContainerToolbarProps): JSX.Element {
  return (
    <div className="fleet-toolbar">
      <h2>Containers</h2>
      <input
        className="input"
        placeholder="Filter by name…"
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      <select
        className="select"
        value={status}
        onChange={(e) => onStatus(e.target.value)}
      >
        {STATUS_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <RefreshButton onClick={onRefresh} loading={loading} />
    </div>
  );
}
