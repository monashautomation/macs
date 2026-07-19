#!/usr/bin/env bash
set -euo pipefail

# jq: used by sunshine-pair.sh to resolve the SSH client's NetBird peer name.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y jq

echo "Creating Sunshine pairing script..."
sudo tee /usr/local/bin/sunshine-pair.sh > /dev/null <<'EOF'
#!/bin/bash
# Pair a Moonlight client with this VM's Sunshine instance.
# Usage: sunshine-pair.sh [client-name]
# Web UI credentials: SUNSHINE_USER (default: current user) and
# SUNSHINE_PASS (prompted when unset).
set -euo pipefail

name="${1:-}"
read -rp 'Enter Moonlight PIN: ' pin

# When run over SSH through the NetBird overlay, default the client name to
# the connecting peer's hostname from netbird's peer list. `netbird status`
# needs the daemon socket, so fall back to sudo; give up quietly and use the
# generic name if neither works.
if [ -z "$name" ] && [ -n "${SSH_CONNECTION:-}" ]; then
  client_ip="${SSH_CONNECTION%% *}"
  nb_json="$(netbird status --json 2>/dev/null || sudo -n netbird status --json 2>/dev/null || true)"
  if [ -n "$nb_json" ]; then
    name="$(printf '%s' "$nb_json" \
      | jq -r --arg ip "$client_ip" \
          '.peers.details[]? | select((.netbirdIp | split("/")[0]) == $ip) | .fqdn' \
      | head -n1 | cut -d. -f1)"
  fi
fi
[ -n "$name" ] || name="moonlight-client"

user="${SUNSHINE_USER:-$USER}"
if [ -n "${SUNSHINE_PASS:-}" ]; then
  pass="$SUNSHINE_PASS"
else
  read -rsp "Sunshine web UI password for $user: " pass; echo
fi

# Pairing goes through the web UI API (HTTPS, self-signed cert, basic auth).
curl -fsk -u "$user:$pass" -X POST https://localhost:47990/api/pin \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg pin "$pin" --arg name "$name" '{pin: $pin, name: $name}')"
echo
EOF
sudo chmod +x /usr/local/bin/sunshine-pair.sh
