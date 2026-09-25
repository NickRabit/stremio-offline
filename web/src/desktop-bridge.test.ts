import { describe, expect, it } from "vitest";
import { desktopBridge } from "./desktop-bridge";

describe("desktopBridge", () => {
  it("is absent in a plain browser", () => {
    expect(desktopBridge({})).toBeNull();
    expect(desktopBridge(undefined)).toBeNull();
  });

  it("is found when the desktop app exposes version 1", () => {
    const pickFolder = async () => "/Users/me/Movies";
    expect(desktopBridge({ stremioDesktop: { version: 1, pickFolder } })?.pickFolder).toBe(pickFolder);
  });

  it("ignores a bridge of another version or shape, so a newer app meets an older page safely", () => {
    expect(desktopBridge({ stremioDesktop: { version: 2, pickFolder: async () => null } })).toBeNull();
    expect(desktopBridge({ stremioDesktop: { version: 1 } })).toBeNull();
  });
});
