#!/usr/bin/env bash
set -euo pipefail

DESKTOP_ENV="${DESKTOP_ENV:-gnome}"

echo "Extending LVM LV..."
sudo lvextend --resizefs -l +100%FREE /dev/mapper/ubuntu--vg-ubuntu--lv

sudo apt-get update

# Block snaps before pulling the desktop. firefox and snapd are only
# Recommends of ubuntu-desktop, but the firefox snap-transitional deb
# stalls the build ~30 min per snap trying to reach the (intermittently
# reachable) snap store. A streaming host has no need for snaps, so remove
# snapd and pin both out.
echo "Disabling snaps (firefox/snapd)..."
sudo systemctl stop snapd.socket snapd.service snapd.seeded.service 2>/dev/null || true
sudo apt-get purge -y snapd || true
sudo rm -rf /var/cache/snapd
sudo tee /etc/apt/preferences.d/no-snaps.pref > /dev/null <<'EOF'
Package: snapd firefox
Pin: release o=Ubuntu
Pin-Priority: -1
EOF

case "$DESKTOP_ENV" in
  gnome)
    echo "Installing GNOME (ubuntu-desktop + gdm3)..."
    sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y ubuntu-desktop gdm3
    ;;
  xfce)
    echo "Installing XFCE (xubuntu-desktop + lightdm)..."
    sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y xubuntu-desktop lightdm
    echo "/usr/sbin/lightdm" | sudo tee /etc/X11/default-display-manager > /dev/null
    ;;
  *)
    echo "Unknown DESKTOP_ENV '$DESKTOP_ENV' (expected gnome|xfce)" >&2
    exit 1
    ;;
esac

# Firefox as a native .deb from Mozilla's APT repo (Ubuntu's firefox is a
# snap stub, blocked above). Mozilla's package has a different origin, so
# the o=Ubuntu pin doesn't touch it; pin it high so it wins.
echo "Installing Firefox (Mozilla APT, non-snap)..."
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg | sudo tee /etc/apt/keyrings/packages.mozilla.org.asc > /dev/null
echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" | sudo tee /etc/apt/sources.list.d/mozilla.list > /dev/null
sudo tee /etc/apt/preferences.d/mozilla > /dev/null <<'EOF'
Package: *
Pin: origin packages.mozilla.org
Pin-Priority: 1000
EOF
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y firefox

# Disable startup popups
sudo DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get remove -y ubuntu-release-upgrader-core gnome-initial-setup || true
