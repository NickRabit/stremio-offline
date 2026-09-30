#!/usr/bin/env bash
# Builds the FFmpeg the Linux desktop app carries: LGPL (no --enable-gpl, so no x264), with VAAPI
# for Intel and AMD GPUs and NVENC for NVIDIA, and a static OpenSSL for https sources. The build
# runs inside a pinned ubuntu:22.04 container, so the binaries need glibc 2.35 and newer. Every
# input is a pinned release checked against its sha256, and the result records how it was made,
# because shipping FFmpeg under the LGPL means handing out exactly the source and configure line it
# came from.
#
#   desktop/scripts/build-ffmpeg-linux.sh    -> desktop/ffmpeg-linux/{ffmpeg,ffprobe,licenses/,sources/,BUILDINFO.txt}
#
# Needs a Linux x64 host with Docker. Rebuilds nothing when desktop/ffmpeg-linux already matches.
set -euo pipefail

FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
OPENSSL_VERSION=3.5.8
OPENSSL_SHA256=a8f84a39918ec6415ce765d9b429d313ba97b8143169c172e734b9514464f5b2
NV_CODEC_HEADERS_TAG=n13.1.15.0
NV_CODEC_HEADERS_SHA256=52532ceade3d5c1af62624986f13cf01b63c910576b08c0c278756c5e4b41ad0
# ubuntu:22.04 for x86_64, pinned by digest so the glibc the binaries need never moves.
UBUNTU_IMAGE=ubuntu@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$here/ffmpeg-linux"
# The script's own hash is in the stamp, so a changed configure line is a new build.
script_hash="$(sha256sum "${BASH_SOURCE[0]}" | cut -c1-16)"
stamp="ffmpeg $FFMPEG_VERSION (vaapi, nvenc, openssl), linux x64, script $script_hash"
if [ -x "$out/ffmpeg" ] && [ -x "$out/ffprobe" ] && grep -qxF "$stamp" "$out/BUILDINFO.txt" 2>/dev/null; then
  echo "build-ffmpeg-linux: $out is current"
  exit 0
fi

[ "$(uname -s)" = Linux ] || { echo "build-ffmpeg-linux: Linux only" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || { echo "build-ffmpeg-linux: build on an x86_64 host" >&2; exit 1; }

# Everything below runs inside the pinned container, with the repo mounted so the result lands in
# desktop/ffmpeg-linux on the host. The image has no git, so the revision is read from here.
if [ "${FFMPEG_LINUX_IN_CONTAINER:-}" != 1 ]; then
  command -v docker >/dev/null || { echo "build-ffmpeg-linux: install Docker" >&2; exit 1; }
  self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  exec docker run --rm \
    -e FFMPEG_LINUX_IN_CONTAINER=1 \
    -e FFMPEG_LINUX_REPO="$(git -C "$here" remote get-url origin 2>/dev/null | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##' || true)" \
    -e FFMPEG_LINUX_REVISION="$(git -C "$here" describe --tags --always --dirty 2>/dev/null || echo unknown)" \
    -v "$here:$here" -w "$here" "$UBUNTU_IMAGE" \
    bash "$self"
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  build-essential perl nasm make pkg-config libva-dev libdrm-dev zlib1g-dev curl xz-utils ca-certificates

# FFmpeg's configure puts its own -lz and -latomic ahead of --extra-libs, where the shared stubs the
# dev packages install would win; with only the archives left, both link statically and neither
# libz.so.1 nor libatomic.so.1 becomes a DT_NEEDED entry.
rm -f "$(gcc -print-file-name=libz.so)" "$(gcc -print-file-name=libatomic.so)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"

fetch() { # url sha256 file
  curl -sSfL --retry 3 -o "$3" "$1"
  echo "$2  $3" | sha256sum -c - >/dev/null || { echo "build-ffmpeg-linux: checksum mismatch for $3" >&2; exit 1; }
}
fetch "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" "$FFMPEG_SHA256" ffmpeg.tar.xz
fetch "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz" "$OPENSSL_SHA256" openssl.tar.gz
fetch "https://github.com/FFmpeg/nv-codec-headers/releases/download/$NV_CODEC_HEADERS_TAG/nv-codec-headers-${NV_CODEC_HEADERS_TAG#n}.tar.gz" "$NV_CODEC_HEADERS_SHA256" nv-codec-headers.tar.gz
tar xf ffmpeg.tar.xz
tar xf openssl.tar.gz
mkdir nv-codec-headers && tar xf nv-codec-headers.tar.gz -C nv-codec-headers --strip-components=1

jobs="$(nproc)"
# libdir=lib: OpenSSL's linux-x86_64 target defaults to lib64, and the -L below expects lib.
# openssldir=/etc/ssl: certificate checks use the distribution's own CA bundle, as on macOS.
# OpenSSL's perl build prints noise on stderr, so it is logged and shown only when it fails.
(cd "openssl-$OPENSSL_VERSION" \
  && ./Configure linux-x86_64 no-shared no-tests no-docs --prefix="$work/openssl" --openssldir=/etc/ssl --libdir=lib \
  && make -j"$jobs" build_libs \
  && make install_dev) >"$work/openssl.out" 2>&1 \
  || { tail -n 60 "$work/openssl.out" >&2; exit 1; }
make -C nv-codec-headers install PREFIX="$work/nvcodec" >/dev/null
export PKG_CONFIG_PATH="$work/nvcodec/lib/pkgconfig"

# --disable-autodetect: nothing is picked up from whatever else is installed on the build machine,
# so the binaries link only the system libraries named in the allow-list below. OpenSSL is
# Apache-2.0, which FFmpeg's configure accepts only with --enable-version3: the result is
# LGPL-3.0-or-later. --enable-ffnvcodec supplies the NVENC headers; the driver is loaded at run
# time, so there is no link. --disable-devices with lavfi kept, as on Windows: the server's encoder
# probes feed a generated test picture through it and need no capture device.
configure=(
  --disable-autodetect --enable-version3
  --enable-openssl --enable-vaapi --enable-libdrm --enable-ffnvcodec --enable-nvenc --enable-zlib --enable-pthreads
  --disable-devices --enable-indev=lavfi --disable-doc --disable-ffplay --disable-debug --disable-shared --enable-static
  "--extra-cflags=-I$work/openssl/include"
  "--extra-ldflags=-L$work/openssl/lib -static-libgcc"
  --extra-libs=-l:libz.a
)
# configure's own log is what explains a failure on the runner, so it is shown then.
(cd "ffmpeg-$FFMPEG_VERSION" && ./configure --prefix="$work/ffmpeg-out" "${configure[@]}" >"$work/configure.out") \
  || { tail -n 60 "ffmpeg-$FFMPEG_VERSION/ffbuild/config.log" >&2; exit 1; }
# Read back what configure decided, before minutes of compiling: no GPL part, TLS, and the two
# hardware encoders this build is for. A missing feature shows the checks that turned it off.
# The encoders are listed in config_components.h, the features in config.h.
for expected in "CONFIG_GPL 0" "CONFIG_NONFREE 0" "CONFIG_OPENSSL 1" "CONFIG_VAAPI 1" "CONFIG_LIBDRM 1" "CONFIG_H264_VAAPI_ENCODER 1" "CONFIG_H264_NVENC_ENCODER 1"; do
  grep -qx "#define $expected" "ffmpeg-$FFMPEG_VERSION/config.h" "ffmpeg-$FFMPEG_VERSION/config_components.h" 2>/dev/null || {
    echo "build-ffmpeg-linux: config.h lacks '$expected'" >&2
    grep -iE "warning|openssl|vaapi|nvenc|ffnvcodec|drm" "$work/configure.out" >&2 || true
    exit 1
  }
done
(cd "ffmpeg-$FFMPEG_VERSION" \
  && make -j"$jobs" >/dev/null \
  && make install >/dev/null)

# The direct needs (DT_NEEDED), not ldd's whole closure: the only libraries this build may link by
# name are glibc's, libva's and libdrm's. libva-x11 and libX11 are absent because
# --disable-autodetect turns off vaapi_x11, so nothing here draws on X11.
allowed='^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux-x86-64\.so\.2|libva\.so\.2|libva-drm\.so\.2|libdrm\.so\.2)$'
for binary in ffmpeg ffprobe; do
  needed="$(readelf -d "$work/ffmpeg-out/bin/$binary" | sed -n 's/.*(NEEDED).*Shared library: \[\(.*\)\]/\1/p')"
  [ -n "$needed" ] || { echo "build-ffmpeg-linux: no DT_NEEDED entries found in $binary" >&2; exit 1; }
  if grep -vE "$allowed" <<<"$needed"; then
    echo "build-ffmpeg-linux: $binary needs a library outside the allowed set" >&2
    exit 1
  fi
done
"$work/ffmpeg-out/bin/ffmpeg" -hide_banner -L | grep -q "Lesser General Public License" || { echo "build-ffmpeg-linux: not an LGPL build" >&2; exit 1; }

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
{
  echo "$stamp"
  echo
  echo "FFmpeg $FFMPEG_VERSION, licensed LGPL-3.0-or-later as built here (no GPL components)."
  echo "Source: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz (sha256 $FFMPEG_SHA256)"
  echo "Statically linked with OpenSSL $OPENSSL_VERSION (Apache-2.0)."
  echo "Source: https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz (sha256 $OPENSSL_SHA256)"
  echo "H.264 is encoded by VAAPI (libva and libdrm, linked dynamically at the system's versions) or, on NVIDIA, by NVENC."
  echo "The NVENC encoder interface comes from the nv-codec-headers $NV_CODEC_HEADERS_TAG headers (MIT); the driver is loaded at run time."
  echo "Source: https://github.com/FFmpeg/nv-codec-headers/releases/download/$NV_CODEC_HEADERS_TAG/nv-codec-headers-${NV_CODEC_HEADERS_TAG#n}.tar.gz (sha256 $NV_CODEC_HEADERS_SHA256)"
  echo "All three source archives are also attached to every GitHub release that ships this app."
  echo "Built by desktop/scripts/build-ffmpeg-linux.sh in the Stremio Offline repository,"
  echo "${FFMPEG_LINUX_REPO:-https://github.com/NickRabit/stremio-offline} at ${FFMPEG_LINUX_REVISION:-unknown}; the script is in that revision's source archive."
  echo "The build ran in $UBUNTU_IMAGE, so the binaries need glibc 2.35 or newer."
  echo
  echo "OpenSSL: ./Configure linux-x86_64 no-shared no-tests no-docs --openssldir=/etc/ssl --libdir=lib"
  echo "FFmpeg:  ./configure ${configure[*]}" | sed "s#$work#<build>#g"
  echo
  echo "To use another FFmpeg, set FFMPEG_PATH and FFPROBE_PATH for the app"
  echo "(an environment variable for the user, then restart the app)."
} > "$stage/BUILDINFO.txt"
# The sources travel with a release; they are kept next to the build for the workflow to attach.
cp ffmpeg.tar.xz "$stage/sources/ffmpeg-$FFMPEG_VERSION.tar.xz"
cp openssl.tar.gz "$stage/sources/openssl-$OPENSSL_VERSION.tar.gz"
cp nv-codec-headers.tar.gz "$stage/sources/nv-codec-headers-${NV_CODEC_HEADERS_TAG#n}.tar.gz"
rm -rf "$out"
mv "$stage" "$out"
echo "build-ffmpeg-linux: $("$out/ffmpeg" -hide_banner -version | head -1)"
