import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ActionMenu, type ActionMenuItem } from "./ActionMenu";

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

const items = (): ActionMenuItem[] => [
  { key: "first", label: "First", onSelect: vi.fn() },
  { key: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
  { key: "last", label: "Last", onSelect: vi.fn() },
];
const render = async (entries: ActionMenuItem[]) => {
  await act(async () => root.render(<ActionMenu className="trigger" label="Actions" items={entries}>Open</ActionMenu>));
  return host.querySelector<HTMLButtonElement>(".trigger")!;
};
const menu = () => document.querySelector<HTMLElement>(".action-menu");
const open = async (trigger: HTMLButtonElement) => { await act(async () => trigger.click()); };

describe("ActionMenu", () => {
  it("opens with menu semantics and focuses the first enabled item", async () => {
    const trigger = await render(items());
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    await open(trigger);
    expect(menu()?.getAttribute("role")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.textContent).toBe("First");
  });

  it("moves with arrows, Home and End while skipping disabled items", async () => {
    const trigger = await render(items());
    await open(trigger);
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Last");
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("First");
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("Last");
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement?.textContent).toBe("First");
    expect(menu()!.querySelectorAll('[role="menuitem"]:disabled')).toHaveLength(1);
  });

  it("chooses the focused item with Enter", async () => {
    const entries = items();
    const trigger = await render(entries);
    await open(trigger);
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await act(async () => menu()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(entries[2]!.onSelect).toHaveBeenCalledOnce();
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and returns focus to its trigger", async () => {
    const trigger = await render(items());
    await open(trigger);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when the click lands outside", async () => {
    const trigger = await render(items());
    await open(trigger);
    await act(async () => document.body.click());
    expect(menu()).toBeNull();
  });
});
