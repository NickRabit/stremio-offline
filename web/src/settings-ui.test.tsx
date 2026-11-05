import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BROKEN_RETRY_MS, hideBroken } from "./settings-ui";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const picture = () => host.querySelector("img")!;
const fail = () => act(() => { picture().dispatchEvent(new Event("error")); });

describe("hideBroken", () => {
  it("hides a failed picture, asks for it once more and shows it when it arrives", async () => {
    await act(async () => { root.render(<img src="/api/image/a" alt="" onError={hideBroken}/>); });
    const assigned = vi.spyOn(picture(), "src", "set");
    fail();
    expect(picture().classList.contains("broken")).toBe(true);
    expect(assigned).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(BROKEN_RETRY_MS); });
    expect(assigned).toHaveBeenCalledWith("/api/image/a");
    act(() => { picture().dispatchEvent(new Event("load")); });
    expect(picture().classList.contains("broken")).toBe(false);
  });

  it("stays hidden after the second failure and never asks a third time", async () => {
    await act(async () => { root.render(<img src="/api/image/b" alt="" onError={hideBroken}/>); });
    const assigned = vi.spyOn(picture(), "src", "set");
    fail();
    act(() => { vi.advanceTimersByTime(BROKEN_RETRY_MS); });
    fail();
    act(() => { vi.advanceTimersByTime(BROKEN_RETRY_MS * 3); });
    expect(assigned).toHaveBeenCalledTimes(1);
    expect(picture().classList.contains("broken")).toBe(true);
  });

  it("leaves a picture alone once it shows another address", async () => {
    await act(async () => { root.render(<img src="/api/image/c" alt="" onError={hideBroken}/>); });
    const assigned = vi.spyOn(picture(), "src", "set");
    fail();
    await act(async () => { root.render(<img src="/api/image/d" alt="" onError={hideBroken}/>); });
    assigned.mockClear();
    act(() => { vi.advanceTimersByTime(BROKEN_RETRY_MS); });
    expect(assigned).not.toHaveBeenCalled();
  });
});
