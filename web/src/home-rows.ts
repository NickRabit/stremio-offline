import type { Download } from "./types";

export type QueueGroup = "attention" | "paused" | "active" | "waiting" | "queued";
export type QueueAction = "retry" | "resume" | "pause" | "open";

const GROUP_ORDER: Record<QueueGroup, number> = { attention: 0, paused: 1, active: 2, waiting: 3, queued: 4 };
const BLOCKED_REASONS: ReadonlySet<string> = new Set(["storage", "library", "permission"]);

/** No space, a library that is away or a right that was taken back: the account cannot fix
 *  this from Home, so the card points at Downloads instead of offering Resume. */
export const blocked = (job: Download) => job.status === "paused" && (BLOCKED_REASONS.has(job.pauseReason ?? "") || job.libraryGone === true);

export function queueGroup(job: Download): QueueGroup {
  if (job.status === "failed" || blocked(job)) return "attention";
  if (job.status === "paused") return "paused";
  if (job.status === "checking" || job.status === "downloading") return "active";
  if (job.status === "waiting") return "waiting";
  return "queued";
}

/** The account's own jobs, completed ones left out, in the row's fixed order. The byte count
 *  never decides a position, so a poll cannot shuffle the cards. */
export function homeQueue(jobs: Download[]): Download[] {
  const byGroup = (a: Download, b: Download) => GROUP_ORDER[queueGroup(a)] - GROUP_ORDER[queueGroup(b)] || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return jobs.filter((job) => job.mine === true && job.status !== "completed").sort(byGroup);
}

export function queueAction(job: Download): QueueAction {
  if (job.status === "failed") return "retry";
  if (blocked(job)) return "open";
  if (job.status === "paused") return "resume";
  // A completed job is never drawn in the row; opening its own downloads is the only
  // harmless answer this total function can give it.
  if (job.status === "completed") return "open";
  return "pause";
}

/** The jobs the row marks red or amber: failed, or blocked outside the account's control. */
export function attentionCount(jobs: Download[]): number {
  return homeQueue(jobs).filter((job) => queueGroup(job) === "attention").length;
}
