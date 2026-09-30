# Hardware acceleration (Intel QuickSync / VAAPI / NVENC / VideoToolbox / Media Foundation)

Hardware acceleration matters only for a **real transcode**. Direct play and
remux — the common path — never touch the GPU. See
[Playback](playback.md) for which source lands in which mode.

On Synology with an Intel iGPU (a Celeron with QuickSync, for example DS220+ or
DS920+) the container needs two things: access to `/dev/dri`, and membership in
the group that owns the render node. Without that group the process cannot open
the device after switching to `PUID`/`PGID`, and the server silently falls back
to software conversion.

## Turning it on

**Over SSH**, the override file sets both for you:

```bash
docker compose -f compose.yml -f compose.synology.yml up -d --build
```

**In Container Manager** (no SSH, single compose file only), uncomment this
block in `compose.yml`:

```yaml
    devices:
      - /dev/dri:/dev/dri
```

and add `VAAPI_DEVICE=/dev/dri/renderD128` and `RENDER_GID` to `.env`. The right
GID is in the container **Terminal**:

```bash
ls -n /dev/dri
```

The second number on `renderD128` is the group; on DSM 7 it is usually 937
(`videodriver`). On the NAS itself, `stat -c "%g" /dev/dri/renderD128` says the
same. Then stop the project and build it again.

## Verifying it works

The encoder is ready when the log says `VAAPI is available`. At start the server
actually encodes a test frame and separately checks hardware scaling and
bitrate control.

Limited Synology drivers can correctly report `gpuScaling:false` or
`bitrateControl:false`; that is not a bug. The app then decodes and shrinks on
CPU, uploads to the GPU, and hardware-encodes in constant-quality mode. Real GPU
work is confirmed by `hardware:true` on the start, track-change, or seek log
line.

## Quality settings

| Variable | Applies to | Meaning |
| --- | --- | --- |
| `VAAPI_QP` | hardware | CQP quality, default 23. Lower means higher quality and more bitrate. |
| `NVENC_CQ` | NVIDIA hardware | Constant-quality value, default 23. Lower means higher quality and more bitrate. |
| `VIDEOTOOLBOX_QUALITY` | macOS hardware | Constant-quality value 1–100, default 60. Higher means higher quality and more bitrate — the opposite direction to `VAAPI_QP`. |
| `MEDIAFOUNDATION_QUALITY` | Windows hardware | Constant-quality value 1–100, default 60. Only used when the vendor MFT takes constant quality; a chosen quality sets a CBR bitrate instead. |
| `FFMPEG_CRF` | software fallback only | Same idea for `libx264`. |
| `FFMPEG_PRESET` | software fallback only | `libx264` speed/quality trade-off. |

Hardware conversion always transcodes audio to AAC for a reliable fMP4/HLS
output. A plain remux leaves audio untouched.

## macOS (VideoToolbox)

The desktop app's local backend on a Mac has no VAAPI, so it probes
VideoToolbox instead: at start it encodes a test frame and, when that works,
uses it first for a real transcode. Nothing needs installing and nothing needs
switching on. Remux and direct play never touch it, and a Linux or Docker
install never probes it at all. The log line `VideoToolbox is available` says
the path is live; a constant-quality encoder is probed first, and an Intel Mac
that lacks that mode is given a target bitrate instead.

Decoding runs on the media engine (`-hwaccel videotoolbox`, with FFmpeg falling
back to software for a codec the chip cannot decode) and encoding on
`h264_videotoolbox`; scaling stays on the CPU, because the frames come back in
system memory. Measured on an Apple M5 with FFmpeg 9, a 4K HEVC 10-bit → 1080p
conversion cost 2.9 s of CPU per 10 s of video against 11.2 s in software.

Set `VIDEOTOOLBOX=0` in the environment to switch the path off; without it, a
chosen quality (1080p, 720p, 480p) sets the bitrate, and everything else is
encoded at constant quality with `-q:v` — tune it with `VIDEOTOOLBOX_QUALITY`
(default 60).

## Windows (Media Foundation)

The desktop app's local backend on Windows has no VAAPI, and the bundled LGPL
FFmpeg has no libx264 either, so it probes Media Foundation's `h264_mf` at
start. `h264_mf` uses the GPU vendor's encoder when the driver offers one and
Microsoft's software encoder otherwise; both are part of Windows 10 and 11, so
nothing needs installing. The log line `Media Foundation is available` says the
path is live, with `hardware:true` for the vendor MFT and `constantQuality:true`
when it takes constant quality. Remux and direct play never touch it, and a
Linux, Docker or macOS install never probes it at all.

A heavy source — HEVC, AV1, VP9, a 10-bit pixel format, or anything over 1080
lines — is decoded on the GPU (`-hwaccel d3d11va`, with FFmpeg falling back to
software when the D3D11 decoder cannot be set up); a 1080p H.264 is decoded on
the CPU, which is cheaper than the round trip. Encoding is `h264_mf`; scaling
stays on the CPU, because the frames come back in system memory. A chosen
quality sets a CBR target bitrate; without one the vendor MFT is used at
constant quality.

Set `MEDIAFOUNDATION=0` in the environment to switch the path off. Without it, a
chosen quality (1080p, 720p, 480p) sets the bitrate, and everything else uses
the vendor MFT's constant quality — tune it with `MEDIAFOUNDATION_QUALITY`
(default 60).

A virtual machine without a GPU has no vendor encoder, so the probe falls back
to Microsoft's software H.264 encoder. That path still works, but it runs on the
CPU and is slow — a real transcode there is better avoided.

## NVIDIA (NVENC)

FFmpeg's `h264_nvenc` loads the NVIDIA driver's library at run time, so the LGPL
build can carry it and nothing needs installing beyond the driver. It is the
only GPU path for an NVIDIA card on Linux, and on Windows it is preferred over
Media Foundation, where the vendor path was measured slower than software. The
probe runs on every platform, but only when the build lists `h264_nvenc` and
VAAPI has not already come up, so an Intel or AMD host pays nothing for it. Set
`NVENC=0` in the environment to switch the path off.

At start the server encodes a test frame and, when that works, the log line
`NVENC is available` says the path is live. A machine with no NVIDIA driver logs
`NVENC is not available` at INFO rather than WARN, because that is ordinary.
Decoding stays on the CPU; only the encoder runs on the GPU. Without a chosen
quality the encoder runs at constant quality with `-cq` — tune it with
`NVENC_CQ` (default 23). A chosen quality (1080p, 720p, 480p) sets a VBR target
bitrate instead.

## When the driver does not start

`unknown libva error` means the device opens but the driver did not load. See
what is available in the container terminal:

```bash
vainfo --display drm --device /dev/dri/renderD128
```

If libva does not pick a driver, force it in `.env` with `LIBVA_DRIVER_NAME` —
`iHD` for Gemini Lake and newer, `i965` especially for older Braswell.

If VAAPI never comes up, nothing breaks: direct play and remux still work, and a
real transcode falls back to `libx264` on the CPU.
