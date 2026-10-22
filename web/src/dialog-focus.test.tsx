import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDialogFocus } from "./dialog-focus";

let host: HTMLDivElement;
let root: Root;
let trigger: HTMLButtonElement;
function Dialog() {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref);
  return <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1}>
    <button>First</button><button disabled>Disabled</button><button hidden>Hidden</button><button>Last</button>
  </div>;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({ length: 1 } as DOMRectList);
  trigger = document.createElement("button"); document.body.append(trigger); trigger.focus();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root.render(<Dialog/>));
});
afterEach(() => { act(() => root.unmount()); host.remove(); trigger.remove(); vi.restoreAllMocks(); });
const tab = (shiftKey = false) => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }));
it("focuses the first control and wraps Tab in both directions", () => {
  const buttons = host.querySelectorAll("button");
  expect(document.activeElement).toBe(buttons[0]);
  tab(true); expect(document.activeElement).toBe(buttons[3]);
  tab(); expect(document.activeElement).toBe(buttons[0]);
});
it("returns focus to the opening control on close", () => {
  act(() => root.render(null)); expect(document.activeElement).toBe(trigger);
});
it("recovers focus that was moved outside the modal", () => {
  trigger.focus(); tab(); expect(document.activeElement).toBe(host.querySelector("button"));
});
it("leaves a newer modal in control", () => {
  const next = document.createElement("div"); next.setAttribute("role", "dialog"); next.setAttribute("aria-modal", "true");
  next.innerHTML = '<button>Newer</button>'; document.body.append(next);
  const button = next.querySelector("button")!; button.focus(); tab(); expect(document.activeElement).toBe(button); next.remove();
});

it("keeps an all-disabled dialog focused and recovers when a control enables", () => {
  for (const button of host.querySelectorAll("button")) button.disabled = true;
  trigger.focus(); tab(); expect(document.activeElement).toBe(host.querySelector('[role="dialog"]'));
  host.querySelector("button")!.disabled = false;
  tab(true); expect(document.activeElement).toBe(host.querySelector("button"));
});

/** Every modal dialog keeps keyboard focus inside itself and hands it back on close. Read from
 *  the source because most of them only mount deep inside a page; a new modal that forgets the
 *  hook fails here. The player and the trailer manage focus of their own on purpose. */
it("is used by every modal dialog", () => {
  const exempt = new Set(["Player.tsx", "TrailerPlayer.tsx"]);
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const missing = readdirSync(dir)
    .filter((name) => name.endsWith(".tsx") && !name.endsWith(".test.tsx") && !exempt.has(name))
    .filter((name) => {
      const text = readFileSync(path.join(dir, name), "utf8");
      return text.includes('aria-modal="true"') && !text.includes("useDialogFocus(");
    });
  expect(missing).toEqual([]);
});
