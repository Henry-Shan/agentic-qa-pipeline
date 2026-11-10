#!/usr/bin/env bash
# Make ONE preview reachable from outside this Mac (contracts §Sharing a preview).
#
# Previews are dev servers on this machine (http://localhost:33xx), so nobody else
# can open them. This puts whichever run is "published" behind a Cloudflare tunnel
# at a single hostname — qa-preview.example.com — which Universal SSL already
# covers for free. Per-run hostnames (preview-42.qa-preview...) would need a paid
# wildcard cert, which is why there is one shared hostname and a Share button that
# swaps it.
#
# The link is open to anyone who has it. That is safe because the app behind it
# still requires a host-app login: an anonymous visitor gets the same public
# landing page as example.com.
#
# Run:  ./worker/setup-tunnel.sh
set -uo pipefail

TUNNEL="${CF_TUNNEL_NAME:-qa-pipeline}"
PREFIX="${PREVIEW_HOST_PREFIX:-qa-preview-}"
ZONE="${PREVIEW_ZONE:-example.com}"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

say "0. Refuse to touch production"
if [ -z "$PREFIX" ] || [ -z "$ZONE" ]; then
  no "PREVIEW_HOST_PREFIX / PREVIEW_ZONE must both be set — refusing."; exit 1
fi
ok "hostnames will look like ${PREFIX}42.${ZONE} (digits only — cannot spell api/www/qa)"

say "1. Cloudflare login"
if [ -f "$HOME/.cloudflared/cert.pem" ]; then
  ok "already authenticated (~/.cloudflared/cert.pem)"
else
  no "not authenticated"
  echo "     Run this yourself — it opens a browser and needs the example.com zone:"
  echo "       cloudflared tunnel login"
  exit 1
fi

say "2. Tunnel '$TUNNEL'"
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL"; then
  ok "exists"
else
  cloudflared tunnel create "$TUNNEL" >/dev/null 2>&1 && ok "created" || { no "could not create"; exit 1; }
fi

say "3. Switch previews to tunnel mode"
ENV_FILE="$(dirname "$0")/.env"
if grep -q '^PREVIEW_MODE=' "$ENV_FILE"; then
  sed -i '' 's/^PREVIEW_MODE=.*/PREVIEW_MODE=tunnel/' "$ENV_FILE"
else
  printf '\nPREVIEW_MODE=tunnel\n' >> "$ENV_FILE"
fi
ok "PREVIEW_MODE=tunnel · hostnames ${PREFIX}<task>.${ZONE}"
launchctl kickstart -k "gui/$UID/com.qa-pipeline.worker" >/dev/null 2>&1 && ok "worker restarted"

say "4. Use it"
echo "  Every task with a preview gets its own permanent link:"
echo "    https://${PREFIX}<task>.${ZONE}   e.g. https://${PREFIX}47.${ZONE}"
echo "  'Open live preview' on the task page goes there. The link keeps working"
echo "  after the dev server sleeps — the wake service restarts it on request."
