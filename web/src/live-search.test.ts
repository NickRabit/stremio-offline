import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codePointLength, createLiveSearch, LIVE_SEARCH_DELAY_MS, type LiveSearchState } from "./live-search";

describe("codePointLength", () => {
  it("counts code points, not UTF-16 units", () => {
    expect(codePointLength("")).toBe(0);
    expect(codePointLength("ž")).toBe(1);
    expect(codePointLength("😀")).toBe(1);
    expect(codePointLength("žlu")).toBe(3);
  });
});

describe("live search", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const commits: string[] = [];
    const states: LiveSearchState[] = [];
    const live = createLiveSearch({ onCommit: (query) => commits.push(query), onState: (state) => states.push(state) });
    return { live, commits, states };
  };

  it("waits the full delay before committing", () => {
    const { live, commits } = setup();
    live.update("Zku", "");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS - 1);
    expect(commits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(commits).toEqual(["Zku"]);
  });

  it("commits only the last draft when edits arrive quickly", () => {
    const { live, commits } = setup();
    live.update("Zku", "");
    vi.advanceTimersByTime(200);
    live.update("Zkuš", "");
    vi.advanceTimersByTime(200);
    live.update("Zkušební", "");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS);
    expect(commits).toEqual(["Zkušební"]);
  });

  it("trims the draft before committing", () => {
    const { live, commits } = setup();
    live.update("  Zkušební  ", "");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS);
    expect(commits).toEqual(["Zkušební"]);
  });

  it("marks a two code point draft too short and never commits", () => {
    const { live, commits, states } = setup();
    live.update("žl", "");
    expect(live.state()).toBe("tooShort");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS * 10);
    expect(commits).toEqual([]);
    expect(states).toEqual(["tooShort"]);
  });

  it("commits a three code point draft", () => {
    const { live, commits } = setup();
    live.update("žlu", "");
    expect(live.state()).toBe("pending");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS);
    expect(commits).toEqual(["žlu"]);
  });

  it("counts an emoji as one code point", () => {
    const { live, commits } = setup();
    live.update("😀a", "");
    expect(live.state()).toBe("tooShort");
    live.update("😀ab", "");
    expect(live.state()).toBe("pending");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS);
    expect(commits).toEqual(["😀ab"]);
  });

  it("ignores updates while composing and starts the timer at composition end", () => {
    const { live, commits } = setup();
    live.compositionStart();
    live.update("Zkušební", "");
    expect(live.state()).toBe("idle");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS * 10);
    expect(commits).toEqual([]);
    live.compositionEnd("Zkušební", "");
    expect(live.state()).toBe("pending");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS);
    expect(commits).toEqual(["Zkušební"]);
  });

  it("treats a draft equal to the committed query as idle", () => {
    const { live, commits } = setup();
    live.update("Zkušební", "Zkušební");
    expect(live.state()).toBe("idle");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS * 10);
    expect(commits).toEqual([]);
  });

  it("returns to browsing synchronously when the draft is emptied", () => {
    const { live, commits } = setup();
    live.update("", "Zkušební");
    expect(commits).toEqual([""]);
    expect(live.state()).toBe("idle");
  });

  it("drops a pending commit when cancelled", () => {
    const { live, commits } = setup();
    live.update("Zkušební", "");
    expect(live.state()).toBe("pending");
    live.cancel();
    expect(live.state()).toBe("idle");
    vi.advanceTimersByTime(LIVE_SEARCH_DELAY_MS * 10);
    expect(commits).toEqual([]);
  });

  it("reports a state only when it changes", () => {
    const { live, states } = setup();
    live.update("Zk", "");
    live.update("Zku", "");
    live.update("Zk", "");
    expect(states).toEqual(["tooShort", "pending", "tooShort"]);
  });
});
