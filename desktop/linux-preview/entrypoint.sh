#!/usr/bin/env bash
# Installs the mounted .deb (or keeps a mounted AppImage), then starts an Xfce desktop on a
# virtual display and serves it to the browser. Runs as root only for the install.
set -euo pipefail

DISPLAY_NUM=:1
GEOMETRY="${PREVIEW_GEOMETRY:-1600x1000}"

deb="$(ls /opt/app/*.deb 2>/dev/null | head -n 1 || true)"
appimage="$(ls /opt/app/*.AppImage 2>/dev/null | head -n 1 || true)"
if [ -n "$deb" ]; then
  echo "linux-preview: installing $(basename "$deb")"
  apt-get update -qq >/dev/null
  apt-get install -y -qq "$deb" >/dev/null
  launch="stremio-offline"
elif [ -n "$appimage" ]; then
  echo "linux-preview: using $(basename "$appimage")"
  install -m 755 -o tester "$appimage" /home/tester/Stremio-Offline.AppImage
  launch="/home/tester/Stremio-Offline.AppImage --appimage-extract-and-run"
else
  echo "linux-preview: no .deb or .AppImage in /opt/app" >&2
  exit 1
fi

# The container cannot give Electron the user namespaces its sandbox wants, and the .deb's
# AppArmor profile does not apply here. Only for this preview, never in the app.
cat > /home/tester/start-app.sh <<EOF
#!/usr/bin/env bash
export ELECTRON_DISABLE_SANDBOX=1
exec $launch "\$@"
EOF
chmod +x /home/tester/start-app.sh
mkdir -p /home/tester/Desktop
cat > /home/tester/Desktop/stremio-offline.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Stremio Offline
Exec=/home/tester/start-app.sh
Icon=stremio-offline
Terminal=false
EOF
chmod +x /home/tester/Desktop/stremio-offline.desktop
chown -R tester:tester /home/tester

# One session bus for the desktop and the app, so the tray icon and notifications reach Xfce.
sudo -u tester -H bash -c "
  Xvfb $DISPLAY_NUM -screen 0 ${GEOMETRY}x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 1
  export DISPLAY=$DISPLAY_NUM
  eval \$(dbus-launch --sh-syntax)
  startxfce4 >/tmp/xfce.log 2>&1 &
  sleep 3
  x11vnc -display $DISPLAY_NUM -forever -shared -nopw -quiet -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  (sleep 5; /home/tester/start-app.sh >/tmp/app.log 2>&1) &
"
echo "linux-preview: desktop ready at http://localhost:6080/vnc.html?autoconnect=1&resize=scale"
exec websockify --web /usr/share/novnc 6080 localhost:5900
