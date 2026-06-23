import { useState } from "react";
import type { ContainerAction, ContainerStatus } from "../../types/docker.js";
import { containerAction, DockerApiClientError } from "../../client/dockerApiClient.js";
import { ActionConfirmDialog } from "./ActionConfirmDialog.js";

interface ContainerActionBarProps {
  containerId: string;
  containerName: string;
  status: ContainerStatus;
  onActionComplete: () => void;
}

export function ContainerActionBar({
  containerId,
  containerName,
  status,
  onActionComplete,
}: ContainerActionBarProps): JSX.Element {
  const [pending, setPending] = useState<ContainerAction | null>(null);
  const [confirm, setConfirm] = useState<ContainerAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRunning = status === "running";

  async function run(action: ContainerAction): Promise<void> {
    setConfirm(null);
    setPending(action);
    setError(null);
    try {
      await containerAction(containerId, action);
      onActionComplete();
    } catch (err) {
      const message =
        err instanceof DockerApiClientError ? err.message : "Action failed.";
      setError(message);
    } finally {
      setPending(null);
    }
  }

  return (
    <>
      <div className="action-bar">
        <button
          className="btn btn-primary"
          disabled={isRunning || pending !== null}
          onClick={() => setConfirm("start")}
        >
          Start
        </button>
        <button
          className="btn"
          disabled={!isRunning || pending !== null}
          onClick={() => setConfirm("stop")}
        >
          Stop
        </button>
        <button
          className="btn"
          disabled={pending !== null}
          onClick={() => setConfirm("restart")}
        >
          Restart
        </button>
        <button
          className="btn btn-danger"
          disabled={pending !== null}
          onClick={() => setConfirm("remove")}
        >
          Remove
        </button>
        {pending !== null && <span className="spinner" />}
      </div>
      {error !== null && (
        <div className="error-state" style={{ padding: "0 20px 12px" }}>
          {error}
        </div>
      )}
      {confirm !== null && (
        <ActionConfirmDialog
          action={confirm}
          containerName={containerName}
          onConfirm={() => void run(confirm)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}
