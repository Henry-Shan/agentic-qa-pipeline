#!/usr/bin/env bash
# Publish preview builds to other testers (contracts §Preview).
#
# Previews are dev servers on THIS machine (http://localhost:33xx), so nobody
# else can open them. This puts them behind a Cloudflare tunnel at
# preview-<run>.qa-preview.example.com — but ONLY behind Cloudflare Access,
# because a preview is an in-progress build wired to the real Supabase and the
# real API. Public would mean lab data on an unauthenticated hostname.
#
# Run:  ./worker/setup-tunnel.sh
set -uo pipefail

TUNNEL="${CF_TUNNEL_NAME:-qa-pipeline}"
DOMAIN="${PREVIEW_DOMAIN:-qa-preview.example.com}"
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
no()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

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

say "3. Cloudflare Access — the gate that makes this safe"
echo "  This script will NOT publish anything until an Access application covers"
echo "  *.$DOMAIN. Set it up once, in the dashboard:"
echo
echo "    Zero Trust → Access → Applications → Add an application → Self-hosted"
echo "      Application domain : *.$DOMAIN"
echo "      Policy             : Allow · Emails  → your tester list"
echo "      Identity           : One-time PIN (no IdP needed)"
echo
read -r -p "  Is that Access application in place? [y/N] " answer
case "$answer" in
  [yY]*) ;;
  *) echo "  Stopping here. Previews stay local-only, which is the safe default."; exit 0 ;;
esac

say "4. Switch previews to tunnel mode"
ENV_FILE="$(dirname "$0")/.env"
if grep -q '^PREVIEW_MODE=' "$ENV_FILE"; then
  sed -i '' 's/^PREVIEW_MODE=.*/PREVIEW_MODE=tunnel/' "$ENV_FILE"
else
  printf '\nPREVIEW_MODE=tunnel\n' >> "$ENV_FILE"
fi
ok "PREVIEW_MODE=tunnel"
launchctl kickstart -k "gui/$UID/com.qa-pipeline.worker" >/dev/null 2>&1 && ok "worker restarted"

say "5. Verify before trusting it"
echo "  Open a task whose preview is live, click 'Open live preview ↗', and confirm"
echo "  you get the Cloudflare Access sign-in — NOT the app. If the app loads"
echo "  without a prompt, the policy is not covering the hostname: revert with"
echo "    sed -i '' 's/^PREVIEW_MODE=.*/PREVIEW_MODE=local/' $ENV_FILE"
echo "    launchctl kickstart -k gui/\$UID/com.qa-pipeline.worker"
