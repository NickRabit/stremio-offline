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
  let handler: (call: Call) => Promise<string | undefined> = async () => undefined;
  return {
    calls,
    onReport: (next: (call: Call) => Promise<string | undefined>) => { handler = next; },
    manager: {
      reportPlayback: async (current: MediaServerAuthority, libraryId: unknown, itemId: unknown, value: ProviderPlaybackReport) => {
        const call = { authority: current, libraryId: String(libraryId), itemId: String(itemId), report: value };
        calls.push(call);
        return handler(call);
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

test("a provider-issued session id replaces the local fallback after the start report", async () => {
  const fake = fakeManager();
  const providerId = "b".repeat(32);
  fake.onReport(async (call) => call.report.kind === "playing" ? providerId : undefined);
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    newSessionId: () => "a".repeat(32),
  });
  const actor = authority();
  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  await reporter.report(actor, "rlib_1", "item-1", report("progress", { position: 2 }));
  await reporter.report(actor, "rlib_1", "item-1", report("stop", { position: 3 }));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "stopped"]);
  assert.deepEqual(fake.calls.map((call) => call.report.playSessionId), [
    "a".repeat(32),
    providerId,
    providerId,
  ]);
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
  await reporter.report(authority(), "rlib_1", "item-1", report("progress"));
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.report.kind, "playing");
  await reporter.report(authority(), "rlib_1", "item-2", report("stop"));
  assert.equal(fake.calls.length, 1);
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
    return undefined;
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
    return undefined;
  });
  let next = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    newSessionId: () => (next++ === 0 ? "a" : "b").repeat(32),
  });
  await reporter.report(authority(), "rlib_1", "item-1", report("start"));
  await reporter.report(authority(), "rlib_1", "item-1", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.playSessionId), ["a".repeat(32), "b".repeat(32)]);
});

test("a refused start suppresses progress until an explicit start after stop", async () => {
  const fake = fakeManager();
  let refused = true;
  fake.onReport(async (call) => {
    if (call.report.kind === "playing" && refused) {
      refused = false;
      throw new MediaServerError("no-compatible-stream", "refused");
    }
    return undefined;
  });
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
  const actor = authority();

  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  await reporter.report(actor, "rlib_1", "item-1", report("stop"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing"]);

  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "playing"]);
});

test("a refused progress stops upstream until a new start", async () => {
  for (const code of ["authentication-required", "forbidden"] as const) {
    const fake = fakeManager();
    let fail = true;
    fake.onReport(async (call) => {
      if (call.report.kind === "progress" && fail) {
        fail = false;
        throw new MediaServerError(code, "refused");
      }
      return undefined;
    });
    const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority());
    const actor = authority();

    await reporter.report(actor, "rlib_1", "item-1", report("start"));
    await reporter.report(actor, "rlib_1", "item-1", report("progress"));
    await reporter.report(actor, "rlib_1", "item-1", report("progress"));
    assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress"], code);

    await reporter.report(actor, "rlib_1", "item-1", report("start"));
    await reporter.report(actor, "rlib_1", "item-1", report("progress"));
    assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "playing", "progress"], code);
  }
});

test("a rate-limited progress stays quiet without suppressing stop and resumes after the hint", async () => {
  const fake = fakeManager();
  let now = 0;
  const failed = new Set(["item-1", "item-2"]);
  fake.onReport(async (call) => {
    if (call.report.kind === "progress" && failed.delete(call.itemId)) {
      throw new MediaServerError("rate-limited", "slow down", 429, 30_000);
    }
    return undefined;
  });
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), { clock: () => now });
  const actor = authority();

  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  now = 10_000;
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  await reporter.report(actor, "rlib_1", "item-1", report("stop"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "stopped"]);

  await reporter.report(actor, "rlib_1", "item-2", report("start"));
  await reporter.report(actor, "rlib_1", "item-2", report("progress"));
  now = 39_999;
  await reporter.report(actor, "rlib_1", "item-2", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "stopped", "playing", "progress"]);

  now = 40_000;
  await reporter.report(actor, "rlib_1", "item-2", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "progress", "stopped", "playing", "progress", "progress"]);
});

test("a progress after an explicit stop does not create a ghost session", async () => {
  const fake = fakeManager();
  let now = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    clock: () => now,
    tombstoneMs: 60_000,
  });
  const actor = authority();

  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  await reporter.report(actor, "rlib_1", "item-1", report("stop"));
  now = 59_999;
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "stopped"]);

  now = 60_000;
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "stopped", "playing"]);

  await reporter.report(actor, "rlib_1", "item-1", report("stop"));
  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "stopped", "playing", "stopped", "playing"]);
});

test("an idle-swept session is resumed by progress", async () => {
  const fake = fakeManager();
  let now = 0;
  const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
    clock: () => now,
    idleMs: 100,
  });
  const actor = authority();

  await reporter.report(actor, "rlib_1", "item-1", report("start"));
  now = 100;
  await reporter.sweep();
  await reporter.report(actor, "rlib_1", "item-1", report("progress"));
  assert.deepEqual(fake.calls.map((call) => call.report.kind), ["playing", "stopped", "playing"]);
});

test("a stopped report retries one transient failure and not a terminal one", async () => {
  for (const [code, expected] of [["unavailable", 2], ["forbidden", 1]] as const) {
    const fake = fakeManager();
    let attempts = 0;
    const waits: number[] = [];
    fake.onReport(async (call) => {
      if (call.report.kind === "stopped") {
        attempts += 1;
        throw new MediaServerError(code, "failed");
      }
      return undefined;
    });
    const reporter = new MediaServerPlaybackReporter(fake.manager, () => authority(), {
      stopRetryMs: 2_000,
      sleep: async (ms, signal) => {
        assert.equal(signal.aborted, false);
        waits.push(ms);
      },
    });
    const actor = authority();

    await reporter.report(actor, "rlib_1", "item-1", report("start"));
    await reporter.report(actor, "rlib_1", "item-1", report("stop"));
    assert.equal(attempts, expected, code);
    assert.deepEqual(waits, expected === 2 ? [2_000] : [], code);
  }
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
