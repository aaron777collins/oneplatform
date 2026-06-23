import { useContainerStats } from "../../hooks/useContainerStats.js";
import { formatBytes } from "../shared/ByteSize.js";

function StatBar({
  label,
  value,
  percent,
  color,
}: {
  label: string;
  value: string;
  percent: number;
  color: string;
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="stat-bar-wrap">
      <div className="stat-bar-label">
        <span>{label}</span>
        <span className="mono">{value}</span>
      </div>
      <div className="stat-bar-track">
        <div
          className="stat-bar-fill"
          style={{ width: `${clamped}%`, background: color }}
        />
      </div>
    </div>
  );
}

function Sparkline({ values, color }: { values: number[]; color: string }): JSX.Element {
  if (values.length < 2) {
    return <div className="muted" style={{ fontSize: 12 }}>Collecting samples…</div>;
  }
  const max = Math.max(...values, 1);
  const width = 240;
  const height = 40;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${i * step},${height - (v / max) * height}`)
    .join(" ");
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function StatsTab({ containerId }: { containerId: string }): JSX.Element {
  const { current, history, connected, error } = useContainerStats(containerId);

  if (error !== null && current === null) {
    return <div className="muted">{error}</div>;
  }
  if (current === null) {
    return <div className="muted">Loading stats…</div>;
  }

  return (
    <div>
      <div className="muted" style={{ marginBottom: 16 }}>
        {connected ? "● live" : "○ snapshot"}
      </div>
      <StatBar
        label="CPU"
        value={`${current.cpuPercent.toFixed(1)} %`}
        percent={current.cpuPercent}
        color="var(--accent)"
      />
      <Sparkline values={history.map((h) => h.cpuPercent)} color="var(--accent)" />

      <StatBar
        label="Memory"
        value={`${formatBytes(current.memoryUsageBytes)} / ${formatBytes(
          current.memoryLimitBytes,
        )} (${current.memoryPercent.toFixed(1)} %)`}
        percent={current.memoryPercent}
        color="var(--green)"
      />
      <Sparkline
        values={history.map((h) => h.memoryPercent)}
        color="var(--green)"
      />

      <div className="kv-row" style={{ marginTop: 20 }}>
        <span className="kv-key">Network RX / TX</span>
        <span className="kv-value mono">
          {formatBytes(current.netRxBytes)} / {formatBytes(current.netTxBytes)}
        </span>
      </div>
      <div className="kv-row">
        <span className="kv-key">Block Read / Write</span>
        <span className="kv-value mono">
          {formatBytes(current.blockReadBytes)} /{" "}
          {formatBytes(current.blockWriteBytes)}
        </span>
      </div>
    </div>
  );
}
