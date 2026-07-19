#!/usr/bin/env bash
set -euo pipefail

echo "Disabling SSH password authentication..."
sudo sed -i -e 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
