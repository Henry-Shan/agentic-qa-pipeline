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
# still requires a the host app login: an anonymous visitor gets the same public
# landing page as example.com.
#
# Run:  ./worker/setup-tunnel.sh
set -uo pipefail

TUNNEL="${CF_TUNNEL_NAME:-qa-pipeline}"
DOMAIN="${PREVIEW_DOMAIN:-qa-preview.example.com}"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

say "0. Refuse to touch production"
case "$DOMAIN" in
  example.com|www.example.com|api.example.com|qa.example.com|app.example.com|"")
    no "PREVIEW_DOMAIN='$DOMAIN' is a production hostname — refusing."; exit 1 ;;
  *.example.com) ok "$DOMAIN is a preview hostname" ;;
  *) no "PREVIEW_DOMAIN='$DOMAIN' is not under example.com — refusing."; exit 1 ;;
esac

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
if grep -q '^PREVIEW_DOMAIN=' "$ENV_FILE"; then
  sed -i '' "s/^PREVIEW_DOMAIN=.*/PREVIEW_DOMAIN=$DOMAIN/" "$ENV_FILE"
else
  printf 'PREVIEW_DOMAIN=%s\n' "$DOMAIN" >> "$ENV_FILE"
fi
ok "PREVIEW_MODE=tunnel · PREVIEW_DOMAIN=$DOMAIN"
launchctl kickstart -k "gui/$UID/com.qa-pipeline.worker" >/dev/null 2>&1 && ok "worker restarted"

say "4. Use it"
echo "  Open a task whose preview is live and press 'Share this preview'."
echo "  It appears at https://$DOMAIN within ~10s (the worker's settings poll)."
echo "  Sharing another run moves the hostname; 'Stop sharing' takes it down."
echo
echo "  Revert everything with:"
echo "    sed -i '' 's/^PREVIEW_MODE=.*/PREVIEW_MODE=local/' $ENV_FILE"
echo "    launchctl kickstart -k gui/\$UID/com.qa-pipeline.worker"
