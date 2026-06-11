#!/usr/bin/env bash
# Builds standalone op binaries for all supported platforms using Bun's compile feature.
# Run after `pnpm build` to ensure TypeScript is compiled first.
# Output: dist/op-{platform}-{arch}
# SHA-256 checksums written to dist/checksums.sha256
set -euo pipefail

OUT_DIR="$(dirname "$0")/../dist"
ENTRY="$(dirname "$0")/../src/index.ts"

mkdir -p "$OUT_DIR"

bun build --compile --target bun-linux-x64   "$ENTRY" --outfile "$OUT_DIR/op-linux-amd64"
bun build --compile --target bun-linux-arm64 "$ENTRY" --outfile "$OUT_DIR/op-linux-arm64"
bun build --compile --target bun-darwin-arm64 "$ENTRY" --outfile "$OUT_DIR/op-darwin-arm64"
bun build --compile --target bun-darwin-x64   "$ENTRY" --outfile "$OUT_DIR/op-darwin-amd64"
bun build --compile --target bun-windows-x64  "$ENTRY" --outfile "$OUT_DIR/op-windows-amd64.exe"

sha256sum "$OUT_DIR"/op-* > "$OUT_DIR/checksums.sha256"
echo "Binaries built. Checksums:"
cat "$OUT_DIR/checksums.sha256"
