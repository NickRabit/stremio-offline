/** The executable named by the variable, or the bare name that `PATH` resolves. Read per call,
 *  so a test or a container can set the variable after the module was imported. */
const executable = (env: NodeJS.ProcessEnv, variable: string, fallback: string) => {
  const value = env[variable];
  return value !== undefined && value.trim().length > 0 ? value.trim() : fallback;
};

/** The ffmpeg executable: FFMPEG_PATH when set and non-empty, otherwise "ffmpeg" found on PATH. Read per call. */
export function ffmpegPath(env: NodeJS.ProcessEnv = process.env): string {
  return executable(env, "FFMPEG_PATH", "ffmpeg");
}

/** The same for ffprobe and FFPROBE_PATH. */
export function ffprobePath(env: NodeJS.ProcessEnv = process.env): string {
  return executable(env, "FFPROBE_PATH", "ffprobe");
}
