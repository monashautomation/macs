#!/usr/bin/env bash
set -euo pipefail

if [ "${DESKTOP_ENV:-gnome}" != "gnome" ]; then
  echo "Desktop is ${DESKTOP_ENV}; skipping GNOME defaults."
  exit 0
fi

# Applied to the gdm user so the defaults hold on the greeter and first login.
# dbus-run-session (base dbus pkg) instead of dbus-launch (dbus-x11, absent).
echo "Setting GNOME defaults..."
sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.desktop.interface color-scheme 'prefer-dark'
sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.desktop.session idle-delay 0
sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.desktop.screensaver lock-enabled false
