#!/usr/bin/env bash
# Builds the FFmpeg the macOS desktop app carries: LGPL (no --enable-gpl, so no x264), with
# VideoToolbox for H.264 encoding and a static OpenSSL for https sources. Every input is a pinned
# release checked against its sha256, and the result records how it was made, because shipping
# FFmpeg under the LGPL means handing out exactly the source and configure line it came from.
#
#   desktop/scripts/build-ffmpeg.sh            -> desktop/ffmpeg/{ffmpeg,ffprobe,licenses/,BUILDINFO.txt}
#
# Needs only Xcode's command line tools. Rebuilds nothing when desktop/ffmpeg already matches.
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
OPENSSL_VERSION=3.5.8
OPENSSL_SHA256=a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2
MACOS_MIN=12.0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/ffmpeg"
# The script's own hash is in the stamp, so a changed configure line is a new build.
script_hash="$(shasum -a 256 "${BASH_SOURCE[0]}" | cut -c1-16)"
stamp="ffmpeg $FFMPEG_VERSION + openssl $OPENSSL_VERSION, macOS $MACOS_MIN, arm64, script $script_hash"
if [ -x "$out/ffmpeg" ] && [ -x "$out/ffprobe" ] && grep -qxF "$stamp" "$out/BUILDINFO.txt" 2>/dev/null; then
  echo "build-ffmpeg: $out is current"
  exit 0
fi

[ "$(uname -s)" = Darwin ] || { echo "build-ffmpeg: macOS only" >&2; exit 1; }
# OpenSSL is configured for arm64 and FFmpeg for the host, so an Intel host would fail to link.
[ "$(uname -m)" = arm64 ] || { echo "build-ffmpeg: build on an arm64 Mac (not under Rosetta)" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch() { # url sha256 file
  curl -sSfL --retry 3 -o "$3" "$1"
  echo "$2  $3" | shasum -a 256 -c - >/dev/null || { echo "build-ffmpeg: checksum mismatch for $3" >&2; exit 1; }
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" ffmpeg.tar.xz
fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_SHA256" openssl.tar.gz
tar xf ffmpeg.tar.xz
tar xf openssl.tar.gz

jobs="$(sysctl -n hw.ncpu)"
# openssldir=/etc/ssl: certificate checks use macOS's own CA bundle, /etc/ssl/cert.pem, the way
# a Homebrew FFmpeg does. Verification stays on, as FFmpeg's default.
(cd "openssl-$OPENSSL_VERSION" \
  && ./Configure darwin64-arm64-cc no-shared no-tests no-docs --prefix="$work/openssl" --openssldir=/etc/ssl "-mmacosx-version-min=$MACOS_MIN" >/dev/null \
  && make -j"$jobs" build_libs >/dev/null \
  && make install_dev >/dev/null)

# --disable-autodetect: nothing is picked up from whatever else is installed on the build
# machine, so the binary links only macOS's own libraries. OpenSSL is Apache-2.0, which
# FFmpeg's configure accepts only with --enable-version3: the result is LGPL-3.0-or-later.
configure=(
  --disable-autodetect --enable-version3
  --enable-openssl --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-iconv --enable-pthreads
  --disable-doc --disable-ffplay --disable-debug --disable-shared --enable-static
  "--extra-cflags=-I$work/openssl/include -mmacosx-version-min=$MACOS_MIN"
  "--extra-ldflags=-L$work/openssl/lib -mmacosx-version-min=$MACOS_MIN"
  --extra-libs=-liconv
)
(cd "ffmpeg-$FFMPEG_VERSION" \
  && ./configure --prefix="$work/ffmpeg-out" "${configure[@]}" >/dev/null \
  && make -j"$jobs" >/dev/null \
  && make install >/dev/null)

for binary in ffmpeg ffprobe; do
  links="$(otool -L "$work/ffmpeg-out/bin/$binary")" || { echo "build-ffmpeg: otool failed on $binary" >&2; exit 1; }
  if tail -n +2 <<<"$links" | grep -vE "^\s+(/System/|/usr/lib/)"; then
    echo "build-ffmpeg: $binary links something outside macOS" >&2
    exit 1
  fi
done
"$work/ffmpeg-out/bin/ffmpeg" -hide_banner -L | grep -q "Lesser General Public License" || { echo "build-ffmpeg: not an LGPL build" >&2; exit 1; }

# Assembled beside the final place and moved in last, so a failure never leaves a half-built
# directory that the stamp check would take for a current one.
stage="$work/stage"
mkdir -p "$stage/licenses" "$stage/sources"
cp "$work/ffmpeg-out/bin/ffmpeg" "$work/ffmpeg-out/bin/ffprobe" "$stage/"
cp "ffmpeg-$FFMPEG_VERSION/COPYING.LGPLv3" "ffmpeg-$FFMPEG_VERSION/COPYING.GPLv3" "$stage/licenses/"
cp "ffmpeg-$FFMPEG_VERSION/LICENSE.md" "$stage/licenses/FFMPEG-LICENSE.md"
cp "openssl-$OPENSSL_VERSION/LICENSE.txt" "$stage/licenses/OPENSSL-LICENSE.txt"
# Some FFmpeg files are BSD-licensed and ask for their notice in binary distributions, and
# FFmpeg's LICENSE.md asks executables to credit the IJG. Over-inclusive on purpose: every such
# file in the tree, whether or not this configuration compiles it.
{
  echo "Notices for parts of FFmpeg $FFMPEG_VERSION under other licences than the LGPL."
  echo
  echo "This software is based in part on the work of the Independent JPEG Group."
  (cd "ffmpeg-$FFMPEG_VERSION" && grep -rlE "Redistributions in binary form" libavcodec libavdevice libavfilter libavformat libavutil libswresample libswscale fftools 2>/dev/null | sort) |
    while read -r file; do
      echo
      echo "== $file =="
      awk '/\/\*/{inside=1} inside{print} /\*\//{if(inside) exit}' "ffmpeg-$FFMPEG_VERSION/$file"
    done
} > "$stage/licenses/FFMPEG-THIRD-PARTY-NOTICES.txt"
repo="$(git -C "$here" remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##' || true)"
revision="$(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo unknown)"
{
  echo "$stamp"
  echo
  echo "FFmpeg $FFMPEG_VERSION, licensed LGPL-3.0-or-later as built here (no GPL components)."
  echo "Source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz (sha256 $FFMPEG_SHA256)"
  echo "Statically linked with OpenSSL $OPENSSL_VERSION (Apache-2.0)."
  echo "Source: https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz (sha256 $OPENSSL_SHA256)"
  echo "Both source archives are also attached to every GitHub release that ships this app."
  echo "Built by desktop/scripts/build-ffmpeg.sh in the Stremio Offline repository,"
  echo "${repo:-https://github.com/NickRabit/stremio-offline} at $revision; the script is in that revision's source archive."
  echo
  echo "OpenSSL: ./Configure darwin64-arm64-cc no-shared no-tests no-docs --openssldir=/etc/ssl -mmacosx-version-min=$MACOS_MIN"
  echo "FFmpeg:  ./configure ${configure[*]}" | sed "s#$work#<build>#g"
  echo
  echo "To use another FFmpeg, set FFMPEG_PATH and FFPROBE_PATH for the app"
  echo "(launchctl setenv FFMPEG_PATH /path/to/ffmpeg, then restart the app)."
} > "$stage/BUILDINFO.txt"
# The sources travel with a release; they are kept next to the build for the workflow to attach.
cp ffmpeg.tar.xz "$stage/sources/ffmpeg-$FFMPEG_VERSION.tar.xz"
cp openssl.tar.gz "$stage/sources/openssl-$OPENSSL_VERSION.tar.gz"
rm -rf "$out"
mv "$stage" "$out"
echo "build-ffmpeg: $("$out/ffmpeg" -hide_banner -version | head -1)"
