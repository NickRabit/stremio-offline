import path from "node:path";

/** The path rules of one platform, so Windows paths are decided the same way everywhere. */
export function pathFor(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? path.win32 : path.posix;
}
