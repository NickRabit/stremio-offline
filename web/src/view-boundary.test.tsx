import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { en } from "./i18n/en";
import { setLocale } from "./i18n";
import { ViewBoundary } from "./view-boundary";

let root: Root;
let host: HTMLDivElement;
let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  consoleError.mockRestore();
});

const Crash = ({ crash }: { crash: boolean }) => {
  if (crash) throw new Error("boom");
  return <p>content</p>;
};

const alertBox = () => host.querySelector<HTMLElement>("[role=alert]");
const buttons = () => [...(alertBox()?.querySelectorAll("button") ?? [])];

describe("ViewBoundary", () => {
  it("shows the message, focuses Try again, and leaves siblings outside the boundary", async () => {
    await act(async () => {
      root.render(<div><ViewBoundary resetKey="a"><Crash crash/></ViewBoundary><p>sibling</p></div>);
    });

    const alert = alertBox();
    expect(alert?.textContent).toContain(en["viewError.message"]);
    expect(alert?.classList.contains("view-error-overlay")).toBe(false);
    expect(buttons().map((button) => button.textContent)).toEqual([en["common.retry"], en["viewError.reload"]]);
    expect(document.activeElement).toBe(buttons()[0]);
    const sibling = [...host.querySelectorAll("p")].find((node) => node.textContent === "sibling");
    expect(sibling).toBeTruthy();
    expect(alert?.contains(sibling!)).toBe(false);
    expect(consoleError).toHaveBeenCalledWith("view crashed", expect.any(Error), expect.anything());
  });

  it("renders the child again when Try again is used after it stops throwing", async () => {
    let crash = true;
    const Child = () => {
      if (crash) throw new Error("boom");
      return <p>content</p>;
    };
    await act(async () => { root.render(<ViewBoundary resetKey="a"><Child/></ViewBoundary>); });
    expect(alertBox()).not.toBeNull();

    crash = false;
    await act(async () => { buttons()[0]!.click(); });
    expect(alertBox()).toBeNull();
    expect(host.textContent).toBe("content");
  });

  it("clears a failure when resetKey changes", async () => {
    await act(async () => { root.render(<ViewBoundary resetKey="a"><Crash crash/></ViewBoundary>); });
    expect(alertBox()).not.toBeNull();

    await act(async () => { root.render(<ViewBoundary resetKey="b"><Crash crash={false}/></ViewBoundary>); });
    expect(alertBox()).toBeNull();
    expect(host.textContent).toBe("content");
  });

  it("calls the injected reload", async () => {
    const reload = vi.fn();
    await act(async () => { root.render(<ViewBoundary resetKey="a" reload={reload}><Crash crash/></ViewBoundary>); });
    await act(async () => { buttons()[1]!.click(); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shows Close only with onClose, calls it, and covers the screen for the player", async () => {
    const onClose = vi.fn();
    await act(async () => { root.render(<ViewBoundary resetKey="closed"><Crash crash/></ViewBoundary>); });
    expect(host.querySelector(".view-error-overlay")).toBeNull();
    expect(buttons().some((button) => button.textContent === en["common.close"])).toBe(false);

    await act(async () => {
      root.render(<ViewBoundary resetKey="open:stream" onClose={onClose}><Crash crash/></ViewBoundary>);
    });
    expect(alertBox()?.classList.contains("view-error-overlay")).toBe(true);
    const close = buttons().find((button) => button.textContent === en["common.close"]);
    expect(close).toBeTruthy();
    await act(async () => { close!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("catches an error thrown while a function child builds its elements", async () => {
    const build = (): never => { throw new Error("built badly"); };
    await act(async () => {
      root.render(<div><ViewBoundary resetKey="a">{() => <p>{build()}</p>}</ViewBoundary><p>sibling</p></div>);
    });

    expect(alertBox()?.textContent).toContain(en["viewError.message"]);
    expect(host.textContent).toContain("sibling");
  });

  it("adds the container's class to the fallback", async () => {
    await act(async () => {
      root.render(<ViewBoundary resetKey="a" fallbackClassName="person-view"><Crash crash/></ViewBoundary>);
    });

    expect(alertBox()?.classList.contains("person-view")).toBe(true);
    expect(alertBox()?.classList.contains("view-error")).toBe(true);
  });
});
