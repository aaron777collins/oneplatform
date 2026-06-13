#!/bin/sh
# docker/nginx-frontend-start.sh
#
# Substitutes environment variables into the nginx config template then
# launches nginx in the foreground.
#
# NGINX_GATEWAY_URL — upstream gateway address (default: http://gateway-service:3000).
#   In docker-compose this resolves via the internal network.
#   In production, set this to the internal load-balancer address.

set -e

NGINX_GATEWAY_URL="${NGINX_GATEWAY_URL:-http://gateway-service:3000}"

export NGINX_GATEWAY_URL

# Substitute $NGINX_GATEWAY_URL in the template and write the rendered config.
# Only this one variable is substituted; all other $ sequences in the nginx
# config (e.g. $host, $remote_addr) are left untouched by quoting them
# as literal strings in the template — envsubst replaces only exported vars.
envsubst '${NGINX_GATEWAY_URL}' \
  < /etc/nginx/nginx.conf.template \
  > /etc/nginx/nginx.conf

echo "[nginx-frontend] Gateway URL: $NGINX_GATEWAY_URL"
echo "[nginx-frontend] Starting nginx..."

exec nginx -g "daemon off;"
