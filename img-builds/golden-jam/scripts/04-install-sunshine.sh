#!/usr/bin/env bash
set -euo pipefail

SUNSHINE_VERSION="${SUNSHINE_VERSION:-v2026.516.143833}"

# Official deb, NOT the flatpak: the flatpak cannot do KMS capture, which
# is the only capture path that works under GNOME on Wayland (no wlroots
# protocols in Mutter, and Xwayland capture is a black screen).
echo "Installing Sunshine ${SUNSHINE_VERSION} (deb)..."
curl -fsSL -o /tmp/sunshine.deb "https://github.com/LizardByte/Sunshine/releases/download/${SUNSHINE_VERSION}/sunshine-ubuntu-22.04-amd64.deb"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y /tmp/sunshine.deb

# KMS capture requires CAP_SYS_ADMIN on the binary.
sudo setcap cap_sys_admin+p "$(readlink -f "$(command -v sunshine)")"

# Config dir for the default user
sudo -u baker mkdir -p /home/baker/.config/sunshine
