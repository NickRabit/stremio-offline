# Building and releasing the image

Building on the NAS is a poor use of time, and Container Manager uses the classic
builder, where an empty `ARG TARGETARCH` silently drops the VAAPI drivers. The
image is built elsewhere and the NAS only pulls it.

## Locally

One command typechecks, runs tests, builds for the chosen architecture, prints
what is in the image, and packs it:

```bash
./scripts/build-image.sh
```

That produces `dist/stremio-offline-amd64-<date>.tar.gz`. Upload it to the NAS
and add it in Container Manager via **Image → Add → Add from file**. `--arch`,
`--tag`, and `--out` change architecture, tag, and output directory.

## On GitHub

The **Build image** workflow does the same. Run it by hand (**Actions → Build
image → Run workflow**) or by publishing a version.

It runs the tests, builds `linux/amd64` and `linux/arm64` separately — the
repository is public, so both architectures get a free native runner and no
emulation is needed — merges them into one manifest list, and pushes to GHCR as
`ghcr.io/nickrabit/stremio-offline:latest` and under the commit SHA. It then
checks that the amd64 image actually contains VAAPI drivers, and fails the job
otherwise. arm64 is not checked; QuickSync does not run there.

A manual run can also attach a downloadable amd64 tarball instead of pushing to
GHCR.

Images are not built on every push: that would waste a run on every commit. Once
work lands on `main` through pull requests only, adding
`on: push: branches: [main]` to the workflow is reasonable.

## Pulling on the NAS

Use `compose.pull.yml` instead of `compose.yml`:

```bash
docker compose -f compose.pull.yml pull
docker compose -f compose.pull.yml up -d
```

One catch: Container Manager downloads an image only when it does not have it
yet. A project that already pulled `:latest` will start the old one again after a
stop/start. Ask for a new image explicitly — delete the local one under
**Image** and start the project, or run `scripts/nas-update.sh`, which pulls and
restarts:

```bash
./scripts/nas-update.sh /volume2/docker/stremio-offline
```

Without SSH, hang that script on **Control Panel → Task Scheduler → Create →
User-defined script**, run as `root`. That also works on a schedule.

The GHCR package inherits repository visibility, so a private repository means
the NAS must log in with a token (Container Manager → Registry → Settings). If
you do not mind anyone seeing the image, make the package public — the repository
can stay private and the login goes away. The image holds the app, not your data.

## Releasing versions

`:latest` does not say what is in the image. The commit SHA does, but nobody
remembers it. For a readable history, tag a commit on `main`:

```bash
git tag v0.4.0
git push origin v0.4.0
```

That starts **Release**, which calls **Build image**, so the published version is
built and tested from the tagged commit. Beside `:latest` and the commit SHA you
get `:0.4.0` and `:0.4`. Only after a successful build does a GitHub Release
appear, with notes generated from commit messages.

Pin a version on the NAS or a Mac instead of `:latest`:

```yaml
image: ghcr.io/nickrabit/stremio-offline:0.4.0
```

## Other hosts

**Apple Silicon Mac.** The same image works: `docker pull` and
`docker compose up` pick the architecture that matches the machine, so an
M-series Mac downloads a ready arm64 image instead of building for eight minutes
under emulation.

**Windows.** The image is the Linux one — Docker Desktop runs Linux containers
through WSL2, so no Windows variant is needed. Two host-side changes: comment out
the `devices:` block in `compose.yml` (`/dev/dri` does not exist on Windows and
the container would refuse to start), and point `DATA_PATH` and `DOWNLOAD_PATH`
into WSL rather than `/mnt/c/...`. Crossing the filesystem boundary is slow
enough to notice on downloads and artwork. QuickSync does not work on Windows, so
a real transcode runs on the CPU; a desktop PC minds that less than a Celeron in
a NAS.
