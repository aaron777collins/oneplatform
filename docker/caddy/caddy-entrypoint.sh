#!/bin/sh
set -e

OP_TLS_MODE="${OP_TLS_MODE:-internal}"
OP_DOMAIN="${OP_DOMAIN:-localhost}"
OP_TLS_EMAIL="${OP_TLS_EMAIL:-}"

# The container runs with a read-only root filesystem, so the rendered Caddyfile
# is written to /tmp (a writable tmpfs) rather than /etc/caddy. We must NOT mount
# a tmpfs over /etc/caddy itself — that would mask the Caddyfile.dev /
# Caddyfile.prod.template / Caddyfile.nossl sources baked into the image.
RENDERED="/tmp/Caddyfile"

case "$OP_TLS_MODE" in
  internal)
    cp /etc/caddy/Caddyfile.dev "$RENDERED"
    ;;
  auto)
    if [ -z "$OP_DOMAIN" ] || [ "$OP_DOMAIN" = "localhost" ]; then
      echo "[caddy-entrypoint] ERROR: OP_DOMAIN must be set to a real domain when OP_TLS_MODE=auto" >&2
      exit 1
    fi
    if ! echo "$OP_DOMAIN" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]+$'; then
      echo "[caddy-entrypoint] ERROR: OP_DOMAIN contains invalid characters: $OP_DOMAIN" >&2
      exit 1
    fi
    if [ -z "$OP_TLS_EMAIL" ]; then
      echo "[caddy-entrypoint] ERROR: OP_TLS_EMAIL must be set when OP_TLS_MODE=auto" >&2
      exit 1
    fi
    envsubst '${OP_DOMAIN} ${OP_TLS_EMAIL}' \
      < /etc/caddy/Caddyfile.prod.template \
      > "$RENDERED"
    ;;
  off)
    cp /etc/caddy/Caddyfile.nossl "$RENDERED"
    ;;
  *)
    echo "[caddy-entrypoint] ERROR: Unknown OP_TLS_MODE=$OP_TLS_MODE (valid: internal|auto|off)" >&2
    exit 1
    ;;
esac

echo "[caddy-entrypoint] TLS mode: $OP_TLS_MODE"
exec caddy run --config "$RENDERED" --adapter caddyfile
