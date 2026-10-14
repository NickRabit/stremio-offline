import { describe, expect, it } from "vitest";
import { initialPlaybackPosition, progressToSave } from "./player-progress";

const meta = { key: "movie:tt1", title: "Film", path: undefined, poster: "p.jpg", addonKey: undefined };

describe("progressToSave", () => {
  it("sends the position with the title's details", () => {
    expect(progressToSave({ position: 42, duration: 5400 }, meta)).toEqual({ ...meta, position: 42, duration: 5400 });
  });

  it("sends nothing before the length is known", () => {
    expect(progressToSave({ position: 42, duration: 0 }, meta)).toBeNull();
  });

  it("sends nothing in the first five seconds", () => {
    expect(progressToSave({ position: 4.9, duration: 5400 }, meta)).toBeNull();
    expect(progressToSave({ position: 5, duration: 5400 }, meta)).not.toBeNull();
  });
});

describe("initialPlaybackPosition", () => {
  it("starts from the beginning when the viewer asked for it, whatever is saved", () => {
    expect(initialPlaybackPosition({ position: 900 }, null, true)).toBe(0);
    expect(initialPlaybackPosition({ position: 900, mediaSourceId: "v1" }, { mediaSourceId: "v1" }, true)).toBe(0);
  });

  it("resumes a saved position that is worth resuming", () => {
    expect(initialPlaybackPosition({ position: 900 }, null, false)).toBe(900);
    expect(initialPlaybackPosition({ position: 900, mediaSourceId: "v1" }, { mediaSourceId: "v1" }, false)).toBe(900);
  });

  it("starts at the top before the threshold and for a title already watched", () => {
    expect(initialPlaybackPosition({ position: 30 }, null, false)).toBe(0);
    expect(initialPlaybackPosition({ position: 4 }, null, false)).toBe(0);
    expect(initialPlaybackPosition({ position: 900, watched: true }, null, false)).toBe(0);
  });

  it("resumes only the version the saved state belongs to", () => {
    expect(initialPlaybackPosition({ position: 900, mediaSourceId: "v2" }, { mediaSourceId: "v1" }, false)).toBe(0);
    expect(initialPlaybackPosition({ position: 900 }, { mediaSourceId: "v1" }, false)).toBe(0);
  });

  it("treats a missing or unusable position as the beginning", () => {
    expect(initialPlaybackPosition(null, null, false)).toBe(0);
    expect(initialPlaybackPosition(undefined, null, false)).toBe(0);
    expect(initialPlaybackPosition({ position: Number.NaN }, null, false)).toBe(0);
    expect(initialPlaybackPosition({ position: Number.POSITIVE_INFINITY }, null, false)).toBe(0);
    expect(initialPlaybackPosition({ position: -5 }, null, false)).toBe(0);
  });
});
