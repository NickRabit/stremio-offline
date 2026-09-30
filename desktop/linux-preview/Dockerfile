# A throwaway Ubuntu desktop for trying the Linux app by hand on a Mac or any Docker host: Xfce on
# a virtual display, shown in the browser through noVNC. Not a product image; see
# desktop/scripts/linux-preview.sh.
FROM --platform=linux/amd64 ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
# xfce4 with a tray (the app's tray icon shows there), dbus for notifications and the tray,
# noVNC for the browser view, the system ffmpeg (with libx264) for the "Use the system's FFmpeg"
# switch, and the libraries the .deb declares so its install does not have to fetch much.
RUN apt-get update && apt-get install -y --no-install-recommends \
      xfce4 xfce4-terminal xfce4-notifyd dbus-x11 xvfb x11vnc novnc websockify \
      ffmpeg libva2 libva-drm2 libdrm2 libglib2.0-bin libfuse2t64 \
      fonts-dejavu ca-certificates sudo xdg-utils x11-utils procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -s /bin/bash tester \
    && mkdir -p /home/tester/Videos && chown tester:tester /home/tester/Videos

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
