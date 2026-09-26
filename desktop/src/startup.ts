import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ServerProfile } from "./connection-file.js";
import type { ProbeFailure } from "./status.js";

/** What the app connects to: the backend it runs itself, or a saved server profile. */
export type Target = { kind: "local" } | { kind: "profile"; id: string };

export const STARTUP_FILE = "startup.json";

export const MAX_TARGET_ID = 200;

const readTarget = (value: unknown): Target | null => {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "local") return { kind: "local" };
  if (record.kind !== "profile") return null;
  const id = record.id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_TARGET_ID) return null;
  return { kind: "profile", id };
};

/** The file is read leniently: a missing, unreadable or malformed file and a value of the wrong shape all mean "no choice". */
export async function readStartupChoice(dir: string): Promise<Target | null> {
  let text: string;
  try {
    text = await readFile(path.join(dir, STARTUP_FILE), "utf8");
  } catch {
    return null;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  return readTarget((body as Record<string, unknown>).target);
}

export async function writeStartupChoice(dir: string, target: Target | null): Promise<void> {
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `${STARTUP_FILE}.${randomUUID()}`);
  try {
    await writeFile(temporary, JSON.stringify({ target }) + "\n", { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(dir, STARTUP_FILE));
  } catch (error) {
    await rm(temporary).catch(() => {});
    throw error;
  }
}

/** What the window does at launch. A profile that no longer exists means the welcome screen. */
export function launchPlan(
  choice: Target | null,
  profiles: readonly ServerProfile[],
): { screen: "welcome" } | { screen: "connect"; target: Target } {
  if (choice === null) return { screen: "welcome" };
  if (choice.kind === "local") return { screen: "connect", target: choice };
  if (!profiles.some((profile) => profile.id === choice.id)) return { screen: "welcome" };
  return { screen: "connect", target: choice };
}

export function fallbackApplies(target: Target, reason: ProbeFailure): boolean {
  return target.kind === "profile" && reason === "unreachable";
}

export const sameTarget = (a: Target | null, b: Target | null): boolean => {
  if (a === null || b === null) return a === b;
  if (a.kind === "local" && b.kind === "local") return true;
  if (a.kind === "profile" && b.kind === "profile") return a.id === b.id;
  return false;
};

/**
 * "Last requested target wins": every connect request takes a ticket; a result is applied only
 * when its ticket is still the newest. Used so a connect requested from the settings window
 * supersedes one still probing in the main window.
 */
export class LatestRequest {
  private latest: number | null = null;

  next(): number {
    this.latest = (this.latest ?? 0) + 1;
    return this.latest;
  }

  isCurrent(ticket: number): boolean {
    return this.latest !== null && ticket === this.latest;
  }
}
