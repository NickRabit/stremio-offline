import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog, setLocale } from "./i18n";
import { endsAt, formatEndsAt } from "./player-clock";

afterEach(() => setLocale("en"));

describe("endsAt", () => {
  it("adds the remaining duration to the current time", () => {
    expect(endsAt(1_000, 10, 20)).toBe(11_000);
  });

  it("returns nothing when the position is at or past the end", () => {
    expect(endsAt(1_000, 20, 20)).toBeNull();
    expect(endsAt(1_000, 21, 20)).toBeNull();
    expect(endsAt(1_000, Number.NaN, 20)).toBeNull();
  });

  it("returns nothing for an unknown duration", () => {
    expect(endsAt(1_000, 10, 0)).toBeNull();
    expect(endsAt(1_000, 10, Number.NaN)).toBeNull();
    expect(endsAt(1_000, 10, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("clamps a negative position to the start", () => {
    expect(endsAt(1_000, -5, 20)).toBe(21_000);
  });

  it("accounts for the playback speed", () => {
    expect(endsAt(1_000, 10, 20, 2)).toBe(6_000);
    expect(endsAt(1_000, 10, 20, 0.5)).toBe(21_000);
  });
});

describe("formatEndsAt", () => {
  const instant = new Date(2026, 10, 19, 21, 50);

  it("formats English in the interface's 24-hour locale", () => {
    setLocale("en");
    expect(formatEndsAt(instant.getTime())).toBe("21:50");
  });

  it("formats Czech in the interface's locale", async () => {
    await loadCatalog("cs");
    setLocale("cs");
    expect(formatEndsAt(instant.getTime())).toBe("21:50");
  });
});
