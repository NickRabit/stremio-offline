import { describe, expect, it } from "vitest";
import { attentionCount, homeQueue, queueAction, queueGroup } from "./home-rows";
import type { Download } from "./types";

const at = "2026-01-01T00:00:00.000Z";
const job = (over: Partial<Download> & Pick<Download, "id">): Download => ({
  title: over.id, status: "queued", target: `${over.id}.mkv`, received: 0, speed: 0,
  createdAt: at, updatedAt: at, pending: false, order: 0, mine: true, ...over,
});

describe("homeQueue", () => {
  it("keeps the account's own jobs and drops everybody else's", () => {
    const queue = homeQueue([
      job({ id: "mine", mine: true }),
      job({ id: "theirs", mine: false }),
      job({ id: "unknown", mine: undefined }),
    ]);
    expect(queue.map((item) => item.id)).toEqual(["mine"]);
  });

  it("leaves completed jobs out", () => {
    expect(homeQueue([job({ id: "done", status: "completed" }), job({ id: "queued" })]).map((item) => item.id)).toEqual(["queued"]);
  });

  it("orders attention, paused, active, waiting, queued", () => {
    const queue = homeQueue([
      job({ id: "queued", status: "queued" }),
      job({ id: "waiting", status: "waiting" }),
      job({ id: "active", status: "downloading" }),
      job({ id: "paused", status: "paused", pauseReason: "user" }),
      job({ id: "failed", status: "failed" }),
    ]);
    expect(queue.map((item) => item.id)).toEqual(["failed", "paused", "active", "waiting", "queued"]);
  });

  it("keeps a blocked job in the attention group and a failed one beside it", () => {
    const queue = homeQueue([
      job({ id: "blocked", status: "paused", pauseReason: "storage" }),
      job({ id: "failed", status: "failed" }),
    ]);
    expect(queue.map((item) => queueGroup(item))).toEqual(["attention", "attention"]);
  });

  it("orders a group by the stored order and then the id", () => {
    const queue = homeQueue([
      job({ id: "b", status: "downloading", order: 1 }),
      job({ id: "a", status: "downloading", order: 1 }),
      job({ id: "first", status: "downloading", order: 0 }),
    ]);
    expect(queue.map((item) => item.id)).toEqual(["first", "a", "b"]);
  });

  it("does not reorder a group when a byte count changes", () => {
    const before = [job({ id: "a", status: "downloading", order: 0, received: 10, total: 100 }), job({ id: "b", status: "downloading", order: 1, received: 90, total: 100 })];
    const order = homeQueue(before).map((item) => item.id);
    const after = before.map((item) => item.id === "b" ? { ...item, received: 99 } : item);
    expect(homeQueue(after).map((item) => item.id)).toEqual(order);
  });
});

describe("queueAction", () => {
  const cases: Array<[string, Download, string]> = [
    ["queued", job({ id: "j", status: "queued" }), "pause"],
    ["waiting", job({ id: "j", status: "waiting" }), "pause"],
    ["checking", job({ id: "j", status: "checking" }), "pause"],
    ["downloading", job({ id: "j", status: "downloading" }), "pause"],
    ["paused by the user", job({ id: "j", status: "paused", pauseReason: "user" }), "resume"],
    ["paused for storage", job({ id: "j", status: "paused", pauseReason: "storage" }), "open"],
    ["paused for the library", job({ id: "j", status: "paused", pauseReason: "library" }), "open"],
    ["paused for a permission", job({ id: "j", status: "paused", pauseReason: "permission" }), "open"],
    ["paused with the library gone", job({ id: "j", status: "paused", pauseReason: "user", libraryGone: true }), "open"],
    ["failed", job({ id: "j", status: "failed" }), "retry"],
    ["completed", job({ id: "j", status: "completed" }), "open"],
  ];
  for (const [name, item, expected] of cases) it(`answers ${name} with ${expected}`, () => expect(queueAction(item)).toBe(expected));
});

describe("attentionCount", () => {
  it("counts failed and blocked jobs of the account, and nothing else", () => {
    expect(attentionCount([
      job({ id: "failed", status: "failed" }),
      job({ id: "blocked", status: "paused", pauseReason: "permission" }),
      job({ id: "running", status: "downloading" }),
      job({ id: "theirs", status: "failed", mine: false }),
      job({ id: "done", status: "completed" }),
    ])).toBe(2);
  });
});
