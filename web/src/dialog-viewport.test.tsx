import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDialogViewport } from "./dialog-viewport";

function Dialog() {
  const overlay = useRef<HTMLDivElement | null>(null);
  useDialogViewport(overlay);
  return <div ref={overlay} data-testid="overlay">
    <p data-testid="text">Head</p>
    <div data-testid="body" style={{ overflowY: "auto", height: "40px" }}><p>Long</p></div>
  </div>;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const drag = (target: Element) => {
  const event = new Event("touchmove", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

describe("useDialogViewport", () => {
  it("locks the page while any dialog is open and unlocks after the last", async () => {
    await act(async () => root.render(<><Dialog/><Dialog/></>));
    expect(document.documentElement.classList.contains("dialog-locked")).toBe(true);
    await act(async () => root.render(<Dialog/>));
    expect(document.documentElement.classList.contains("dialog-locked")).toBe(true);
    await act(async () => root.render(<></>));
    expect(document.documentElement.classList.contains("dialog-locked")).toBe(false);
  });

  it("cancels a drag outside a scrolling body and lets one inside it through", async () => {
    await act(async () => root.render(<Dialog/>));
    const body = document.querySelector<HTMLElement>('[data-testid="body"]')!;
    Object.defineProperty(body, "scrollHeight", { value: 200 });
    Object.defineProperty(body, "clientHeight", { value: 40 });
    expect(drag(document.querySelector('[data-testid="text"]')!)).toBe(true);
    expect(drag(body.firstElementChild!)).toBe(false);
  });
});
