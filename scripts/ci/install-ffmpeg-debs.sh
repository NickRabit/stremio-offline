#!/usr/bin/env bash
# Installs FFmpeg on a GitHub-hosted Ubuntu runner from the .deb files cached in $1, and falls
# back to apt when there are none or they no longer fit the image. The fallback leaves the
# packages it downloaded in $1, so the workflow's cache step can store them for the next run.
set -euo pipefail

debs="$1"
mkdir -p "$debs"

if compgen -G "$debs/*.deb" > /dev/null && sudo dpkg -i "$debs"/*.deb; then
  ffmpeg -hide_banner -version
  exit 0
fi

rm -f "$debs"/*.deb
sudo apt-get clean
sudo apt-get update
sudo apt-get install -y -f --no-install-recommends ffmpeg
if compgen -G "/var/cache/apt/archives/*.deb" > /dev/null; then
  cp /var/cache/apt/archives/*.deb "$debs"/
fi
ffmpeg -hide_banner -version
