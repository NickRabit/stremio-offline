import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

export type StateRead =
  | { kind: "absent" }
  | { kind: "read"; raw: string }
  | { kind: "unreadable"; error: unknown };

/** ENOENT is "absent"; any other read error is "unreadable". Never throws. */
export async function readStateFile(file: string): Promise<StateRead> {
  try {
    return { kind: "read", raw: await readFile(file, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", error };
  }
}

/** Writes `raw` to `<file>.damaged-<stamp>-<6 hex>` with flag "wx" and mode 0o600,
 *  next to `file`, and returns that path. `<stamp>` is `now.toISOString()` with
 *  ":" and "." replaced by "-" (Windows-safe). Throws if the copy cannot be written. */
export async function preserveDamaged(file: string, raw: string, now: Date = new Date()): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const target = `${file}.damaged-${stamp}-${randomBytes(3).toString("hex")}`;
  await writeFile(target, raw, { flag: "wx", mode: 0o600 });
  return target;
}
