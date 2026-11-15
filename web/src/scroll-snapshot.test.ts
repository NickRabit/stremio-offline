import { afterEach, describe, expect, it, vi } from "vitest";
import { captureScroll, restoreScroll } from "./scroll-snapshot";

const scrollable = (top: number) => {
  const node = document.createElement("div");
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => current,
    set: (value: number) => { current = Number(value); },
  });
  let current = top;
  return node;
};

describe("scroll snapshot", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("records and restores window and element scroll", () => {
    let windowY = 180;
    vi.stubGlobal("scrollTo", (_x: number, y: number) => { windowY = y; });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => windowY });

    const main = document.createElement("main");
    const pane = scrollable(40);
    const nested = scrollable(90);
    const idle = scrollable(0);
    pane.append(nested, idle);
    main.append(pane);
    document.body.append(main);

    const snapshot = captureScroll();
    windowY = 0;
    pane.scrollTop = 0;
    nested.scrollTop = 0;
    idle.scrollTop = 12;

    restoreScroll(snapshot);
    expect(windowY).toBe(180);
    expect(pane.scrollTop).toBe(40);
    expect(nested.scrollTop).toBe(90);
    expect(idle.scrollTop).toBe(12);
  });

  it("skips detached elements", () => {
    let windowY = 12;
    vi.stubGlobal("scrollTo", (_x: number, y: number) => { windowY = y; });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => windowY });

    const main = document.createElement("main");
    const gone = scrollable(55);
    const kept = scrollable(30);
    main.append(gone, kept);
    document.body.append(main);

    const snapshot = captureScroll(main);
    gone.remove();
    kept.scrollTop = 0;
    windowY = 0;

    restoreScroll(snapshot);
    expect(windowY).toBe(12);
    expect(kept.scrollTop).toBe(30);
    expect(gone.isConnected).toBe(false);
    expect(gone.scrollTop).toBe(55);
  });
});
