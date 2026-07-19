#!/usr/bin/env bash
set -euo pipefail

echo "Creating Sunshine pairing script..."
sudo tee /usr/local/bin/sunshine-pair.sh > /dev/null <<EOF
#!/bin/bash
# Prompt for Moonlight PIN
read -p 'Enter Moonlight PIN: ' pin
# Get hostname: flag or Tailscale SSH detection
hostname="\$1"
if [ -z "\$hostname" ] && [ ! -z "\$SSH_CONNECTION" ]; then
  hostname=\$(tailscale status --json | jq -r '.Peer[] | select(.Online) | .HostName' | head -n1)  # Assume first online peer; adjust if needed
fi
# Pair via API (assume default creds; customize if needed)
curl -X POST -u sunshine:password -d "{\"pin\":\"\$pin\",\"hostname\":\"\$hostname\"}" http://localhost:47989/pair
EOF
sudo chmod +x /usr/local/bin/sunshine-pair.sh