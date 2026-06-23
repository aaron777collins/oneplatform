import type { ContainerAction } from "../../types/docker.js";

interface ActionConfirmDialogProps {
  action: ContainerAction;
  containerName: string;
  onConfirm: () => void;
  onCancel: () => void;
}

const COPY: Record<ContainerAction, { title: string; body: string; danger: boolean }> = {
  start: { title: "Start container", body: "Start", danger: false },
  stop: { title: "Stop container", body: "Stop", danger: false },
  restart: { title: "Restart container", body: "Restart", danger: false },
  remove: {
    title: "Remove container",
    body: "Permanently remove",
    danger: true,
  },
};

export function ActionConfirmDialog({
  action,
  containerName,
  onConfirm,
  onCancel,
}: ActionConfirmDialogProps): JSX.Element {
  const copy = COPY[action];
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h4>{copy.title}</h4>
        <p className="muted">
          {copy.body} <strong>{containerName}</strong>?
          {action === "remove" && " This action cannot be undone."}
        </p>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className={`btn ${copy.danger ? "btn-danger" : "btn-primary"}`}
            onClick={onConfirm}
          >
            {copy.title}
          </button>
        </div>
      </div>
    </div>
  );
}
