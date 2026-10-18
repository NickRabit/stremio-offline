import assert from "node:assert/strict";
import { test } from "node:test";
import type { MediaServerAuthority } from "./media-server-manager.js";
import type { ProviderPlaybackReport } from "./media-server-provider.js";
import { MediaServerPlaybackReporter, readPlaybackReport, type PlaybackReport } from "./media-server-playing.js";
import { MediaServerError } from "./media-server-types.js";

const authority = (actorId = "usr_playback"): MediaServerAuthority => ({
  actor: { id: actorId, secret: `secret-${actorId}` },
  assertCurrent: () => undefined,
});

const report = (event: PlaybackReport["event"], over: Partial<PlaybackReport> = {}): PlaybackReport => ({
  mediaSourceId: "source-1",
  position: 1,
  paused: false,
  event,
  ...over,
});

interface Call {
  authority: MediaServerAuthority;
  libraryId: string;
  itemId: string;
  report: ProviderPlaybackReport;
}

const fakeManager = () => {
  const calls: Call[] = [];
  let handler: (call: Call) => Promise<void> = async () => undefined;
  return {
    calls,
    onReport: (next: (call: Call) => Promise<void>) => { handler = next; },
    manager: {
      reportPlayback: async (current: MediaServerAuthority, libraryId: unknown, itemId: unknown, value: ProviderPlaybackReport) => {
        const call = { authority: current, libraryId: String(libraryId), itemId: String(itemId), report: value };
        calls.push(call);
        await handler(call);
      },
    },
  };
};

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("start, progress and stop carry the lifecycle kinds and one session id", async () => {
  const fake = fakeManager();
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    newSessionId: () => "a".repeat(32),
  });
  const actor = authority();
  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { position: 2, paused: true }));
  await reporter.report(actor, "rlib_1", "item-1", report("stop", { position: 3, paused: true }));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "stopped"]);
  assert.deepEqual(fake.calls.map((call) => call.report.playSessionId), ["a".repeat(32), "a".repeat(32), "a".repeat(32)]);
  assert.equal(fake.calls[0]!.report.positionTicks, 10_000_000);
  assert.equal(fake.calls[2]!.report.positionTicks, 30_000_000);
});

test("progress derives Pause, Unpause and TimeUpdate from the previous pause state", async () => {
  const fake = fakeManager();
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
  const actor = authority();
  await reporter.report(actor, "rlib_1", "item-1", report("start", { paused: false }));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { paused: false }));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { paused: true }));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { paused: true }));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { paused: false }));
  assert.deepEqual(fake.calls.slice(1).map((call) => call.report.eventName), ["TimeUpdate", "Pause", "TimeUpdate", "Unpause"]);
});

test("progress on an unknown key starts a session and stop on an unknown key sends nothing", async () => {
  const fake = fakeManager();
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
  await reporter.report(authority(), "rlib_1", "item-1", report("stop"));
  assert.equal(fake.calls.length, 0);
  await reporter.report(authority(), "rlib_1", "item-1", report("progress"));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.report.kind, "playing");
});

test("reports for one key cannot overtake each other", async () => {
  const fake = fakeManager();
  const entered = deferred();
  const release = deferred();
  fake.onReport(async (call) => {
    if (call.report.kind === "playing") {
      entered.resolve();
      await release.promise;
    }
  });
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
  const first = reporter.report(authority(), "rlib_1", "item-1", report("start"));
  await entered.promise;
  const second = reporter.report(authority(), "rlib_1", "item-1", report("progress"));
  await tick();
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing"], "the progress waits for the start");
  release.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress"]);
});

test("a failed start forgets its session and a later progress starts a new one", async () => {
  const fake = fakeManager();
  let fail = true;
  fake.onReport(async () => {
    if (fail) {
      fail = false;
      throw new MediaServerError("not-found", "gone");
    }
  });
  let next = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    newSessionId: () => (next++ === 0 ? "a" : "b").repeat(32),
  });
  await reporter.report(authority(), "rlib_1", "item-1", report("start"));
  await reporter.report(authority(), "rlib_1", "item-1", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.playSessionId), ["a".repeat(32), "b".repeat(32)]);
});

test("the idle sweep stops through a rebuilt authority and uses the last position", async () => {
  const fake = fakeManager();
  let now = 0;
  const rebuilt: MediaServerAuthority[] = [];
  const reporter = new MediaServerPlaybackReporter(fake.manager, (actorId) => {
    const value = authority(actorId);
    rebuilt.push(value);
    return value;
  }, { clock: () => now, idleMs: 1_000 });
  await reporter.report(authority("usr_idle"), "rlib_1", "item-1", report("start", { position: 4 }));
  await reporter.report(authority("usr_idle"), "rlib_1", "item-1", report("progress", { position: 7.25, paused: true }));
  now = 1_001;
  await reporter.sweep();
  assert.equal(rebuilt.length, 1);
  assert.equal(rebuilt[0]!.actor.id, "usr_idle");
  assert.equal(fake.calls.at(-1)!.report.kind, "stopped");
  assert.equal(fake.calls.at(-1)!.report.positionTicks, 72_500_000);
});

test("an idle key whose actor is gone is forgotten without an upstream call", async () => {
  const fake = fakeManager();
  let now = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => undefined, { clock: () => now, idleMs: 10 });
  await reporter.report(authority(), "rlib_1", "item-1", report("start"));
  now = 20;
  await reporter.sweep();
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing"]);
});

test("the thirty-third key stops the least recently seen session", async () => {
  const fake = fakeManager();
  let now = 0;
  let next = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    clock: () => now,
    newSessionId: () => (next++).toString(16).padStart(32, "0"),
  });
  for (let index = 0; index < 32; index += 1) {
    await reporter.report(authority(), "rlib_1", `item-${index}`, report("start"));
  }
  now += 1;
  await reporter.report(authority(), "rlib_1", "item-0", report("progress", { paused: true }));
  now += 1;
  await reporter.report(authority(), "rlib_1", "item-32", report("start"));
  await tick();
  const stopped = fake.calls.filter((call) => call.report.kind === "stopped");
  assert.deepEqual(stopped.map((call) => call.itemId), ["item-1"]);
});

test("close stops every live session and report swallows manager failures", async () => {
  const fake = fakeManager();
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
  await reporter.report(authority(), "rlib_1", "item-1", report("start"));
  await reporter.report(authority(), "rlib_1", "item-2", report("start"));
  fake.onReport(async () => { throw new MediaServerError("unavailable", "offline"); });
  await reporter.report(authority(), "rlib_1", "item-3", report("start"));
  await reporter.close();
  const stopped = fake.calls.filter((call) => call.report.kind === "stopped").map((call) => call.itemId).sort();
  assert.deepEqual(stopped, ["item-1", "item-2"], "the failed start left nothing for close to stop");
});

test("readPlaybackReport accepts exactly the four validated fields", () => {
  assert.deepEqual(readPlaybackReport({ mediaSourceId: " source-1 ", position: 12.5, paused: true, event: "progress" }), {
    mediaSourceId: "source-1", position: 12.5, paused: true, event: "progress",
  });
  for (const bad of [
    { mediaSourceId: "v1", position: 1, paused: false, event: "start", extra: 1 },
    { mediaSourceId: "v1", position: 1, paused: false },
    { mediaSourceId: "", position: 1, paused: false, event: "start" },
    { mediaSourceId: "v1", position: "1", paused: false, event: "start" },
    { mediaSourceId: "v1", position: -1, paused: false, event: "start" },
    { mediaSourceId: "v1", position: 10_000_001, paused: false, event: "start" },
    { mediaSourceId: "v1", position: 1, paused: "false", event: "start" },
    { mediaSourceId: "v1", position: 1, paused: false, event: "pause" },
  ]) {
    assert.throws(() => readPlaybackReport(bad), (error) => error instanceof MediaServerError && error.code === "invalid-input");
  }
});
