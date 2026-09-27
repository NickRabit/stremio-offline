#!/usr/bin/env bash
# Builds the FFmpeg the Windows desktop app carries: cross-compiled on Linux with mingw-w64, LGPL
# (no --enable-gpl, so no x264), linked statically so the exe needs no mingw runtime DLL, with
# schannel for https sources and Media Foundation (h264_mf) for H.264 encoding. Every input is a
# pinned release checked against its sha256, and the result records how it was made, because
# shipping FFmpeg under the LGPL means handing out exactly the source and configure line it came
# from. The exe cannot run on the build host; the packaged Windows smoke test runs it.
#
#   desktop/scripts/build-ffmpeg-win.sh    -> desktop/ffmpeg-win/{ffmpeg.exe,ffprobe.exe,licenses/,sources/,BUILDINFO.txt}
#
# Packages needed on Ubuntu 24.04: mingw-w64 nasm pkg-config make xz-utils curl libz-mingw-w64-dev.
# Rebuilds nothing when desktop/ffmpeg-win already matches.
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
cross=x86_64-w64-mingw32-

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/ffmpeg-win"
# The script's own hash is in the stamp, so a changed configure line is a new build.
script_hash="$(sha256sum "${BASH_SOURCE[0]}" | cut -c1-16)"
stamp="ffmpeg $FFMPEG_VERSION (schannel, mediafoundation), windows x64, script $script_hash"
if [ -x "$out/ffmpeg.exe" ] && [ -x "$out/ffprobe.exe" ] && grep -qxF "$stamp" "$out/BUILDINFO.txt" 2>/dev/null; then
  echo "build-ffmpeg-win: $out is current"
  exit 0
fi

[ "$(uname -s)" = Linux ] || { echo "build-ffmpeg-win: Linux only" >&2; exit 1; }
command -v "${cross}gcc" >/dev/null || { echo "build-ffmpeg-win: install mingw-w64" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch() { # url sha256 file
  curl -sSfL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "build-ffmpeg-win: checksum mismatch for $3" >&2; exit 1; }
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" ffmpeg.tar.xz
tar xf ffmpeg.tar.xz

src="$work/ffmpeg-$FFMPEG_VERSION"
jobs="$(nproc)"
# --disable-autodetect: nothing is picked up from whatever else is installed on the build machine,
# so the exe links only Windows' own libraries. --enable-version3 with no --enable-gpl is what
# makes the result LGPL-3.0-or-later, as on macOS. -static keeps libgcc out of the DLL imports;
# mingw's w32threads default (no --enable-pthreads) keeps libwinpthread-1.dll out too.
# --disable-devices: the app never captures a camera or the screen, and the capture devices
# (vfwcap, dshow, gdigrab) would pull AVICAP32 and more into the imports.
configure=(
  --disable-autodetect --enable-version3
  --target-os=mingw32 --arch=x86_64 --cross-prefix="$cross"
  --enable-schannel --enable-mediafoundation --enable-d3d11va --enable-dxva2 --enable-zlib
  --disable-devices --disable-doc --disable-ffplay --disable-debug --disable-shared --enable-static
  --extra-ldflags=-static
)
# configure's own log is what explains a failure on the runner, so it is shown then.
(cd "$src" && ./configure --prefix="$work/ffmpeg-out" "${configure[@]}" >"$work/configure.out") \
  || { tail -n 60 "$src/ffbuild/config.log" >&2; exit 1; }
# Read back what configure decided, before minutes of compiling: no GPL part, and the two
# Windows features this build is for. A missing feature shows the checks that turned it off.
for expected in "CONFIG_GPL 0" "CONFIG_NONFREE 0" "CONFIG_SCHANNEL 1" "CONFIG_H264_MF_ENCODER 1"; do
  grep -qx "#define $expected" "$src/config.h" || {
    echo "build-ffmpeg-win: config.h lacks '$expected'" >&2
    grep -iE "warning|mediafoundation|schannel" "$work/configure.out" >&2 || true
    grep -iE "MEDIAFOUNDATION|MFTRANSFORM|SCHANNEL" "$src/config.h" >&2 || true
    grep -n -A14 -E "^check_headers mftransform\.h|^check_func_headers mfapi\.h" "$src/ffbuild/config.log" >&2 || true
    exit 1
  }
done
(cd "$src" \
  && make -j"$jobs" >/dev/null \
  && make install >/dev/null)


# Anything outside that set is a mingw runtime DLL that would have to travel with the exe. Windows'
# own DLLs are allowed, mfplat.dll is not listed because desktop mode loads it at run time.
allowed='^(kernel32|user32|gdi32|shell32|oleaut32|advapi32|bcrypt|ole32|secur32|ncrypt|crypt32|ws2_32|shlwapi|msvcrt|api-ms-win-.*)\.dll$'
for binary in ffmpeg ffprobe; do
  imports="$("${cross}objdump" -p "$work/ffmpeg-out/bin/$binary.exe" | sed -n 's/.*DLL Name: *//p')"
  [ -n "$imports" ] || { echo "build-ffmpeg-win: no DLL imports found in $binary.exe" >&2; exit 1; }
  if grep -vEi "$allowed" <<<"$imports"; then
    echo "build-ffmpeg-win: $binary.exe imports something outside the Windows system set" >&2
    exit 1
  fi
done

# Assembled beside the final place and moved in last, so a failure never leaves a half-built
# directory that the stamp check would take for a current one.
stage="$work/stage"
mkdir -p "$stage/licenses" "$stage/sources"
cp "$work/ffmpeg-out/bin/ffmpeg.exe" "$work/ffmpeg-out/bin/ffprobe.exe" "$stage/"
cp "$src/COPYING.LGPLv3" "$src/COPYING.GPLv3" "$stage/licenses/"
cp "$src/LICENSE.md" "$stage/licenses/FFMPEG-LICENSE.md"
# Some FFmpeg files are BSD-licensed and ask for their notice in binary distributions, and
# FFmpeg's LICENSE.md asks executables to credit the IJG. Over-inclusive on purpose: every such
# file in the tree, whether or not this configuration compiles it.
{
  echo "Notices for parts of FFmpeg $FFMPEG_VERSION under other licences than the LGPL."
  echo
  echo "This software is based in part on the work of the Independent JPEG Group."
  (cd "$src" && grep -rlE "Redistributions in binary form" libavcodec libavdevice libavfilter libavformat libavutil libswresample libswscale fftools 2>/dev/null | sort) |
    while read -r file; do
      echo
      echo "== $file =="
      awk '/\/\*/{inside=1} inside{print} /\*\//{if(inside) exit}' "$src/$file"
    done
} > "$stage/licenses/FFMPEG-THIRD-PARTY-NOTICES.txt"
repo="$(git -C "$here" remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##' || true)"
revision="$(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo unknown)"
{
  echo "$stamp"
  echo
  echo "FFmpeg $FFMPEG_VERSION, licensed LGPL-3.0-or-later as built here (no GPL components)."
  echo "Source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz (sha256 $FFMPEG_SHA256)"
  echo "TLS uses Windows' schannel, not OpenSSL, so no OpenSSL notice belongs to this build."
  echo "H.264 is encoded by Media Foundation (h264_mf); decoding can use D3D11VA or DXVA2."
  echo "The source archive is also attached to every GitHub release that ships this app."
  echo "Built by desktop/scripts/build-ffmpeg-win.sh in the Stremio Offline repository,"
  echo "${repo:-https://github.com/NickRabit/stremio-offline} at $revision; the script is in that revision's source archive."
  echo
  echo "FFmpeg:  ./configure ${configure[*]}" | sed "s#$work#<build>#g"
  echo
  echo "To use another FFmpeg, set FFMPEG_PATH and FFPROBE_PATH for the app"
  echo "(an environment variable for the user, then restart the app)."
} > "$stage/BUILDINFO.txt"
# The sources travel with a release; they are kept next to the build for the workflow to attach.
cp ffmpeg.tar.xz "$stage/sources/ffmpeg-$FFMPEG_VERSION.tar.xz"
rm -rf "$out"
mv "$stage" "$out"
echo "build-ffmpeg-win: $out ready"
