import { beforeEach, describe, expect, it } from "vitest";
import { queueDrainNotice } from "./App";
import { setLocale } from "./i18n";
import type { DownloadDrainView } from "../../server/src/api-types";

const drain = (overrides: Partial<DownloadDrainView> = {}): DownloadDrainView => ({
  id: "drain-1",
  at: "2026-11-12T01:00:00.000Z",
  completed: 2,
  failed: 1,
  paused: 0,
  ...overrides,
});

describe("queue drain notice", () => {
  beforeEach(() => {
    localStorage.clear();
    setLocale("en");
  });

  it("notifies once for a drain and remembers it across a reload", () => {
    const firstRef = { current: null as string | null };
    expect(queueDrainNotice(drain(), "alice", firstRef, localStorage))
      .toBe("The download queue has finished: 2 downloaded, 1 failed.");
    expect(queueDrainNotice(drain(), "alice", firstRef, localStorage)).toBeNull();
    expect(queueDrainNotice(drain(), "alice", { current: null }, localStorage)).toBeNull();
  });

  it("does nothing without a drain", () => {
    expect(queueDrainNotice(null, "alice", { current: null }, localStorage)).toBeNull();
  });

  it("keeps the seen id per account", () => {
    const aliceRef = { current: null as string | null };
    const bobRef = { current: null as string | null };
    expect(queueDrainNotice(drain(), "alice", aliceRef, localStorage)).not.toBeNull();
    expect(queueDrainNotice(drain(), "bob", bobRef, localStorage)).not.toBeNull();
  });

  it("still notifies once while polling when storage throws", () => {
    const storage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    const lastRef = { current: null as string | null };
    expect(queueDrainNotice(drain(), "alice", lastRef, storage)).not.toBeNull();
    expect(queueDrainNotice(drain(), "alice", lastRef, storage)).toBeNull();
    expect(queueDrainNotice(drain(), "alice", lastRef, storage)).toBeNull();
  });

  it("includes paused jobs when present", () => {
    expect(queueDrainNotice(drain({ paused: 3 }), "alice", { current: null }, localStorage))
      .toBe("The download queue has finished: 2 downloaded, 1 failed, 3 still paused.");
  });
});
