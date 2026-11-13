import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, Suspense, useEffect, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { en } from "./i18n/en";
import { setLocale } from "./i18n";
import { lazyScreen, LazyScreenBoundary } from "./lazy-screen";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((done) => setTimeout(done, 0));
  });
};

const until = async (ready: () => boolean) => {
  for (let step = 0; step < 30 && !ready(); step += 1) await flush();
  expect(ready()).toBe(true);
};

describe("lazyScreen", () => {
  it("imports once when preload is called twice and flips ready after it resolves", async () => {
    let resolveLoad!: (component: ComponentType) => void;
    const load = vi.fn(() => new Promise<ComponentType>((resolve) => { resolveLoad = resolve; }));
    const screen = lazyScreen(load);
    expect(screen.ready()).toBe(false);
    const first = screen.preload();
    const second = screen.preload();
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.ready()).toBe(false);
    resolveLoad(() => null);
    await first;
    await second;
    expect(screen.ready()).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("resolves a failed preload, stays unready, and calls the loader again", async () => {
    const load = vi.fn<() => Promise<ComponentType>>()
      .mockRejectedValueOnce(new Error("missing"))
      .mockResolvedValueOnce(() => null);
    const screen = lazyScreen(load);
    await expect(screen.preload()).resolves.toBeUndefined();
    expect(screen.ready()).toBe(false);
    const second = screen.preload();
    expect(load).toHaveBeenCalledTimes(2);
    await second;
    expect(screen.ready()).toBe(true);
  });

  it("shows a retry that reloads the page when the screen import fails", async () => {
    const reload = vi.fn();
    const screen = lazyScreen(() => Promise.reject(new Error("missing")));
    await act(async () => {
      root.render(<LazyScreenBoundary reload={reload}><Suspense fallback={null}><screen.Screen /></Suspense></LazyScreenBoundary>);
    });
    await until(() => host.querySelector("button")?.textContent === en["common.retry"]);
    expect(host.querySelector(".home-note.bad span")?.textContent).toBe(en["api.unreachable"]);
    await act(async () => { host.querySelector("button")!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("draws a preloaded screen without suspending, and keeps one mounted across renders", async () => {
    let mounts = 0;
    const Inner = ({ label }: { label: string }) => { useEffect(() => { mounts += 1; }, []); return <p>{label}</p>; };
    const screen = lazyScreen(() => Promise.resolve(Inner));
    await screen.preload();
    await act(async () => { root.render(<Suspense fallback={<i>wait</i>}><screen.Screen label="a"/></Suspense>); });
    expect(host.querySelector("i")).toBeNull();
    expect(host.textContent).toBe("a");
    await act(async () => { root.render(<Suspense fallback={<i>wait</i>}><screen.Screen label="b"/></Suspense>); });
    expect(host.textContent).toBe("b");
    expect(mounts).toBe(1);
  });

  it("keeps a screen mounted through React.lazy after its import resolves", async () => {
    let mounts = 0;
    const Inner = ({ label }: { label: string }) => { useEffect(() => { mounts += 1; }, []); return <p>{label}</p>; };
    const screen = lazyScreen(() => Promise.resolve(Inner));
    await act(async () => { root.render(<Suspense fallback={null}><screen.Screen label="a"/></Suspense>); });
    await until(() => host.textContent === "a");
    await act(async () => { root.render(<Suspense fallback={null}><screen.Screen label="b"/></Suspense>); });
    expect(host.textContent).toBe("b");
    expect(mounts).toBe(1);
  });
});
