interface RefreshButtonProps {
  onClick: () => void;
  loading?: boolean;
}

export function RefreshButton({ onClick, loading = false }: RefreshButtonProps): JSX.Element {
  return (
    <button className="btn" onClick={onClick} disabled={loading} title="Refresh">
      {loading ? <span className="spinner" /> : <span>⟳</span>}
      <span>Refresh</span>
    </button>
  );
}
