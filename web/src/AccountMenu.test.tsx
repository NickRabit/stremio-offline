import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { AccountMenu } from "./AccountMenu";
import { setLocale } from "./i18n";
import type { ProfileEntry, Session } from "./types";

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
  vi.restoreAllMocks();
});

const profiles: ProfileEntry[] = [
  { id: "usr_alice", username: "Alice", unlock: "pin", current: false, avatar: { kind: "preset", id: "fox" } },
  { id: "usr_bob", username: "Bob", unlock: "password", current: true },
];
const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const mount = async ({ session = { username: "Bob", role: "admin", canSwitch: true }, onSettings, allowAvatar = true }: {
  session?: Session;
  onSettings?: () => void;
  allowAvatar?: boolean;
} = {}) => {
  const onSwitchTo = vi.fn();
  const onChangeAvatar = vi.fn();
  const onSignOut = vi.fn();
  await act(async () => {
    root.render(<AccountMenu session={session} onSwitchTo={onSwitchTo} {...(allowAvatar ? { onChangeAvatar } : {})} onSettings={onSettings} onSignOut={onSignOut}/>);
  });
  return { onSwitchTo, onChangeAvatar, onSignOut };
};
const trigger = () => host.querySelector<HTMLButtonElement>(".account-trigger")!;
const open = async () => {
  await act(async () => { trigger().click(); });
  await flush();
};

describe("AccountMenu", () => {
  it("shows the signed-in face, name and administrator badge in a non-focusable header", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue({ profiles });
    await mount();
    await open();
    const header = document.querySelector(".account-menu-head")!;
    expect(header.textContent).toContain("Bob");
    expect(header.textContent).toContain("Administrator");
    expect(header.querySelector("button")).toBeNull();
  });

  it("lists the other profiles and switches by id", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue({ profiles });
    const { onSwitchTo } = await mount();
    await open();
    const row = document.querySelector<HTMLButtonElement>('[role="menuitem"][aria-label="Switch to Alice"]')!;
    expect(row.textContent).toContain("Alice");
    expect(row.querySelector("img")?.getAttribute("src")).toBe("/avatars/fox.svg");
    await act(async () => { row.click(); });
    expect(onSwitchTo).toHaveBeenCalledWith("usr_alice");
    expect(document.querySelector(".account-menu")).toBeNull();
  });

  it("offers the switcher as a fallback when profiles cannot be read", async () => {
    vi.spyOn(api, "profiles").mockRejectedValue(new Error("offline"));
    const { onSwitchTo } = await mount();
    await open();
    const row = [...document.querySelectorAll<HTMLButtonElement>('.account-menu [role="menuitem"]')]
      .find((entry) => entry.textContent === "Switch profile")!;
    await act(async () => { row.click(); });
    expect(onSwitchTo).toHaveBeenCalledWith(undefined);
  });

  it("leaves Settings out when no handler is available", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue({ profiles });
    await mount();
    await open();
    expect([...document.querySelectorAll('.account-menu [role="menuitem"]')].some((entry) => entry.textContent === "Settings")).toBe(false);
  });

  it("focuses the menu on open and supports arrows, Home, End and Tab", async () => {
    await mount({ session: { username: "Bob", role: "admin" }, onSettings: vi.fn() });
    await open();
    const items = document.querySelectorAll('[role="menuitem"]');
    const press = (key: string) => act(() => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(items[0]);
    press("ArrowUp");
    expect(document.activeElement).toBe(items[2]);
    press("ArrowDown");
    expect(document.activeElement).toBe(items[0]);
    press("End");
    expect(document.activeElement).toBe(items[2]);
    press("Home");
    expect(document.activeElement).toBe(items[0]);
    press("Tab");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("omits Change picture when the action is unavailable", async () => {
    await mount({ session: { username: "Bob", role: "admin" }, allowAvatar: false });
    await open();
    expect([...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)).toEqual(["Sign out"]);
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    vi.spyOn(api, "profiles").mockResolvedValue({ profiles });
    await mount();
    await open();
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(document.querySelector(".account-menu")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
