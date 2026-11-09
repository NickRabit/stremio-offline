import { describe, expect, it } from "vitest";
import { freshPrefetch, NEXT_PREFETCH_FRESH_MS } from "./next-prefetch";

describe("freshPrefetch", () => {
  it("keeps a list read moments ago", () => {
    const entry = { at: 1_000, id: "a" };
    expect(freshPrefetch(entry, 1_000 + 60_000)).toBe(entry);
  });
  it("drops a list read when a half-hour episode started", () => {
    expect(freshPrefetch({ at: 0, id: "a" }, 30 * 60_000)).toBeNull();
    expect(freshPrefetch({ at: 0, id: "a" }, NEXT_PREFETCH_FRESH_MS)).toBeNull();
  });
  it("answers nothing for no prefetch", () => {
    expect(freshPrefetch(null)).toBeNull();
  });
});
