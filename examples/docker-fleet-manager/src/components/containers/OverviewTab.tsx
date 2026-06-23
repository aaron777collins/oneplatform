import type { DockerContainerDetail } from "../../types/docker.js";
import { PortList } from "../shared/PortList.js";
import { formatBytes } from "../shared/ByteSize.js";

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="kv-row">
      <span className="kv-key">{label}</span>
      <span className="kv-value">{children}</span>
    </div>
  );
}

export function OverviewTab({ container }: { container: DockerContainerDetail }): JSX.Element {
  const envEntries = Object.entries(container.envVars);
  return (
    <div>
      <Row label="ID">
        <span className="mono">{container.shortId}</span>
      </Row>
      <Row label="Image">
        <span className="mono">{container.image}</span>
      </Row>
      <Row label="Hostname">{container.hostname || "—"}</Row>
      <Row label="Platform">{container.platform || "—"}</Row>
      <Row label="Restart policy">{container.restartPolicy}</Row>
      <Row label="Created">{new Date(container.createdAt).toLocaleString()}</Row>
      <Row label="Started">
        {container.startedAt !== null
          ? new Date(container.startedAt).toLocaleString()
          : "—"}
      </Row>
      <Row label="Command">
        <span className="mono">
          {[...container.entrypoint, ...container.command].join(" ") || "—"}
        </span>
      </Row>
      <Row label="Ports">
        <PortList ports={container.ports} />
      </Row>
      <Row label="Networks">{container.networks.join(", ") || "—"}</Row>
      {container.sizeRootFs !== null && (
        <Row label="Root FS size">{formatBytes(container.sizeRootFs)}</Row>
      )}

      <h4 style={{ marginTop: 24 }}>Mounts</h4>
      {container.mounts.length === 0 ? (
        <div className="muted">No mounts.</div>
      ) : (
        container.mounts.map((m, i) => (
          <Row key={i} label={m.destination}>
            <span className="mono">
              {m.type} · {m.source || "(anonymous)"} · {m.rw ? "rw" : "ro"}
            </span>
          </Row>
        ))
      )}

      <h4 style={{ marginTop: 24 }}>Environment ({envEntries.length})</h4>
      {envEntries.length === 0 ? (
        <div className="muted">No environment variables.</div>
      ) : (
        envEntries.map(([k, v]) => (
          <Row key={k} label={k}>
            <span className="mono">{v}</span>
          </Row>
        ))
      )}
    </div>
  );
}
