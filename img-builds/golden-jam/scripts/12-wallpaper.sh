#!/usr/bin/env bash
set -euo pipefail

if [ ! -s /usr/local/packer/wallpaper.png ]; then
  echo "No wallpaper file found. Skipping."
  exit 0
fi

echo "Persisting default wallpaper..."
sudo cp /usr/local/packer/wallpaper.png /usr/share/backgrounds/custom-wallpaper.png

if [ "${DESKTOP_ENV:-gnome}" = "gnome" ]; then
  sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.desktop.background picture-uri "file:///usr/share/backgrounds/custom-wallpaper.png"
  sudo -H -u gdm dbus-run-session -- gsettings set org.gnome.desktop.background picture-uri-dark "file:///usr/share/backgrounds/custom-wallpaper.png"
else
  # XFCE: set the wallpaper for every new user via a skeleton xfconf profile.
  sudo mkdir -p /etc/skel/.config/xfce4/xfconf/xfce-perchannel-xml
  sudo tee /etc/skel/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-desktop.xml > /dev/null <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorVirtual-1" type="empty">
        <property name="workspace0" type="empty">
          <property name="last-image" type="string" value="/usr/share/backgrounds/custom-wallpaper.png"/>
          <property name="image-style" type="int" value="5"/>
        </property>
      </property>
    </property>
  </property>
</channel>
EOF
fi
