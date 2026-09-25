import { describe, expect, it } from "vitest";
import { progressToSave } from "./player-progress";

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
