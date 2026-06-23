export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / Math.pow(1024, exp);
  const decimals = value >= 100 || exp === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[exp]}`;
}

export function ByteSize({ bytes }: { bytes: number }): JSX.Element {
  return <span className="mono">{formatBytes(bytes)}</span>;
}
