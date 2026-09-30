import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SYSTEM_FFMPEG_TIMEOUT_MS, findSystemFfmpeg, type PathLookup, type VersionRunner } from "./system-ffmpeg.js";

const LIBX264 = "configuration: --enable-gpl --enable-libx264 --enable-vaapi\n";
const PATH_VALUE = "/usr/local/bin:/usr/bin";

/** A `which` answering from a fixed map, keyed by `<name>@<path>`. */
const lookup = (found: Record<string, string>) => {
  const asked: string[] = [];
  const which: PathLookup = async (name, pathValue) => {
    asked.push(`${name}@${pathValue}`);
    return found[`${name}@${pathValue}`] ?? null;
  };
  return { which, asked };
};

/** A runner that answers with a fixed version output and records its calls. */
const runner = (output: string = LIBX264) => {
  const calls: string[] = [];
  const exec: VersionRunner = async (file, timeoutMs) => {
    calls.push(`${file} ${timeoutMs}`);
    return output;
  };
  return { exec, calls };
};

const SYSTEM = { ffmpeg: "/usr/local/bin/ffmpeg", ffprobe: "/usr/local/bin/ffprobe" };

test("a system FFmpeg is only looked for on Linux", async () => {
  for (const platform of ["darwin", "win32"] as const) {
    const { which, asked } = lookup({ [`ffmpeg@${PATH_VALUE}`]: SYSTEM.ffmpeg });
    const { exec, calls } = runner();
    assert.equal(await findSystemFfmpeg({ PATH: PATH_VALUE }, platform, which, exec), null, platform);
    assert.deepEqual(asked, [], platform);
    assert.deepEqual(calls, [], platform);
  }
});

test("no ffmpeg on the PATH means nothing is found", async () => {
  const { which } = lookup({});
  const { exec, calls } = runner();
  assert.equal(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, exec), null);
  assert.deepEqual(calls, [], "the version is never asked for");
});

test("a missing PATH is walked as empty rather than crashing", async () => {
  const { which, asked } = lookup({});
  assert.equal(await findSystemFfmpeg({}, "linux", which, runner().exec), null);
  assert.deepEqual(asked, ["ffmpeg@"]);
});

test("an ffprobe beside the ffmpeg is preferred", async () => {
  const { which, asked } = lookup({
    [`ffmpeg@${PATH_VALUE}`]: "/usr/local/bin/ffmpeg",
    ["ffprobe@/usr/local/bin"]: "/usr/local/bin/ffprobe",
    [`ffprobe@${PATH_VALUE}`]: "/usr/bin/ffprobe",
  });
  const { exec } = runner();
  assert.deepEqual(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, exec), SYSTEM);
  assert.deepEqual(asked, ["ffmpeg@/usr/local/bin:/usr/bin", "ffprobe@/usr/local/bin"]);
});

test("an ffprobe on the PATH is accepted when none sits beside the ffmpeg", async () => {
  const { which } = lookup({
    [`ffmpeg@${PATH_VALUE}`]: "/usr/local/bin/ffmpeg",
    [`ffprobe@${PATH_VALUE}`]: "/usr/bin/ffprobe",
  });
  assert.deepEqual(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, runner().exec),
    { ffmpeg: "/usr/local/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" });
});

test("no ffprobe anywhere means nothing is found", async () => {
  const { which } = lookup({ [`ffmpeg@${PATH_VALUE}`]: "/usr/local/bin/ffmpeg" });
  const { exec, calls } = runner();
  assert.equal(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, exec), null);
  assert.deepEqual(calls, [], "the version is never asked for");
});

test("the version probe runs the found ffmpeg with a five second timeout", async () => {
  const { which } = lookup({ [`ffmpeg@${PATH_VALUE}`]: SYSTEM.ffmpeg, ["ffprobe@/usr/local/bin"]: SYSTEM.ffprobe });
  const { exec, calls } = runner();
  assert.deepEqual(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, exec), SYSTEM);
  assert.deepEqual(calls, [`${SYSTEM.ffmpeg} ${SYSTEM_FFMPEG_TIMEOUT_MS}`]);
  assert.equal(SYSTEM_FFMPEG_TIMEOUT_MS, 5_000);
});

test("a build without a software H.264 encoder is refused", async () => {
  const { which } = lookup({ [`ffmpeg@${PATH_VALUE}`]: SYSTEM.ffmpeg, ["ffprobe@/usr/local/bin"]: SYSTEM.ffprobe });
  for (const output of ["configuration: --enable-vaapi\n", "", "configuration: --enable-gpl\n"]) {
    assert.equal(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, runner(output).exec), null, JSON.stringify(output));
  }
});

test("a probe that fails means nothing is found", async () => {
  const { which } = lookup({ [`ffmpeg@${PATH_VALUE}`]: SYSTEM.ffmpeg, ["ffprobe@/usr/local/bin"]: SYSTEM.ffprobe });
  const exec: VersionRunner = async () => { throw new Error("timed out"); };
  assert.equal(await findSystemFfmpeg({ PATH: PATH_VALUE }, "linux", which, exec), null);
});

test("the default lookup walks the PATH and needs an executable file", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "stremio-system-ffmpeg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ffmpeg = path.join(dir, "ffmpeg");
  const ffprobe = path.join(dir, "ffprobe");
  await writeFile(ffmpeg, "#!/bin/sh\n", "utf8");
  await writeFile(ffprobe, "#!/bin/sh\n", "utf8");
  await chmod(ffmpeg, 0o755);
  await chmod(ffprobe, 0o755);
  const { exec } = runner();
  assert.deepEqual(await findSystemFfmpeg({ PATH: dir }, "linux", undefined, exec), { ffmpeg, ffprobe });
  // Windows has no executable bit to take away, so the refusal is only observable elsewhere.
  if (process.platform === "win32") return;
  await chmod(ffprobe, 0o644);
  assert.equal(await findSystemFfmpeg({ PATH: dir }, "linux", undefined, exec), null, "a non-executable ffprobe does not count");
});
