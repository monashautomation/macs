#!/usr/bin/env bash
set -euo pipefail

DISPLAY_CONFIG="${SUNSHINE_DISPLAY_CONFIG:-default}"
DESKTOP_ENV="${DESKTOP_ENV:-gnome}"
# Template user; per-VM rename happens via cloud-init at deploy time.
CI_USER="${CI_USER:-baker}"

# Auto-login for the default user. GNOME stays on Wayland; Sunshine
# captures via KMS (deb + CAP_SYS_ADMIN, see 04-install-sunshine.sh),
# which works underneath any compositor.
if [ "$DESKTOP_ENV" = "gnome" ]; then
  echo "Enabling GDM auto-login..."
  sudo sed -i "/\[daemon\]/a AutomaticLoginEnable=true\nAutomaticLogin=${CI_USER}" /etc/gdm3/custom.conf
else
  echo "Enabling LightDM auto-login..."
  sudo mkdir -p /etc/lightdm/lightdm.conf.d
  sudo tee /etc/lightdm/lightdm.conf.d/50-autologin.conf > /dev/null <<EOF
[Seat:*]
autologin-user=${CI_USER}
autologin-user-timeout=0
EOF
fi

# Sunshine launches with the graphical session via XDG autostart, NOT a
# systemd system service: a system service has no session PulseAudio
# (no stream audio) and no session environment.
echo "Enabling Sunshine session autostart..."
sudo mkdir -p /etc/xdg/autostart
sudo tee /etc/xdg/autostart/sunshine.desktop > /dev/null <<'EOF'
[Desktop Entry]
Type=Application
Name=Sunshine
Exec=/usr/bin/sunshine
EOF

# Virtual input: Sunshine creates mouse/keyboard via uinput. The uaccess
# tag grants the seated (auto-logged-in) user access.
echo "Configuring uinput permissions..."
echo uinput | sudo tee /etc/modules-load.d/uinput.conf > /dev/null
sudo modprobe uinput || true
printf 'KERNEL=="uinput", SUBSYSTEM=="misc", OPTIONS+="static_node=uinput", TAG+="uaccess"\n' | sudo tee /etc/udev/rules.d/60-sunshine-input.rules > /dev/null
sudo usermod -aG input "${CI_USER}"

# Display config (only meaningful with an NVIDIA GPU present)
if [ "$DISPLAY_CONFIG" = "virtual" ] && command -v nvidia-xconfig > /dev/null; then
  echo "Configuring virtual displays for Sunshine..."
  sudo nvidia-xconfig --enable-all-gpus --virtual=1920x1080 || true
fi
