import { useEffect, useRef } from "react";
import { useContainerLogs } from "../../hooks/useContainerLogs.js";

export function LogsTab({ containerId }: { containerId: string }): JSX.Element {
  const { lines, connected, error } = useContainerLogs(containerId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  // Auto-scroll to the bottom on new lines, unless the user has scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && autoScroll.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  function onScroll(): void {
    const el = scrollRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScroll.current = atBottom;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <div className="fleet-toolbar" style={{ marginBottom: 8 }}>
        <span className="muted">
          {connected ? "● live" : "○ disconnected"} · {lines.length} lines
        </span>
      </div>
      {error !== null && <div className="muted">{error}</div>}
      <div className="log-viewer" ref={scrollRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <span className="muted">No log output.</span>
        ) : (
          lines.map((l, i) => (
            <div className="log-line" key={i}>
              <span className="log-ts">{formatTs(l.ts)}</span>
              <span>{l.line}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString();
}
