import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api, ApiError } from "./api";
import { setLocale } from "./i18n";
import { ProfileSwitcher } from "./ProfileSwitcher";
import type { ProfileEntry } from "./types";

const profiles = (over: Partial<ProfileEntry> = {}): ProfileEntry[] => [
  { id: "usr_a", username: "Alice", unlock: "pin", current: false, ...over },
  { id: "usr_b", username: "Bob", unlock: "password", current: true },
];

let root: Root;
let host: HTMLDivElement;
let profilesMock: ReturnType<typeof vi.spyOn>;
let switchMock: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  profilesMock = vi.spyOn(api, "profiles").mockResolvedValue({ profiles: profiles() });
  switchMock = vi.spyOn(api, "switchProfile").mockResolvedValue({ username: "Alice", role: "user" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const flush = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
};
const mount = async (confirmStop = false) => {
  const onClose = vi.fn();
  const onSwitched = vi.fn();
  await act(async () => {
    root.render(<ProfileSwitcher onClose={onClose} confirmStop={confirmStop} onSwitched={onSwitched}/>);
  });
  await flush();
  return { onClose, onSwitched };
};
const button = (text: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.includes(text));
const choose = async (name: string) => {
  const row = [...document.body.querySelectorAll<HTMLButtonElement>(".profile-row")].find((entry) => entry.textContent?.includes(name));
  expect(row, `${name}'s row is selectable`).toBeTruthy();
  await act(async () => { row!.click(); await Promise.resolve(); });
};
const fill = async (value: string, selector = ".profile-pin") => {
  const input = document.body.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("ProfileSwitcher", () => {
  it("marks the current profile without making it selectable", async () => {
    await mount();

    expect(profilesMock).toHaveBeenCalledTimes(1);
    const current = document.body.querySelector(".profile-row.current");
    expect(current?.getAttribute("aria-current")).toBe("true");
    expect(current?.textContent).toContain("Current");
    expect(current?.tagName).not.toBe("BUTTON");
    expect(document.body.querySelectorAll("button.profile-row")).toHaveLength(1);
  });

  it("says so when there is nobody to switch to, instead of an empty dialog", async () => {
    profilesMock.mockResolvedValue({ profiles: [] });
    await mount();
    expect(document.body.textContent).toContain("There is no profile to switch to");

    act(() => root.unmount());
    root = createRoot(host);
    profilesMock.mockResolvedValue({ profiles: [{ id: "usr_b", username: "Bob", unlock: "password", current: true }] });
    await mount();
    expect(document.body.querySelector(".profile-row.current")?.textContent).toContain("Bob");
    expect(document.body.textContent).toContain("There is no profile to switch to");
  });

  it("switches immediately to a profile that needs nothing", async () => {
    profilesMock.mockResolvedValue({ profiles: profiles({ unlock: "none" }) });
    const { onSwitched } = await mount();
    await choose("Alice");
    await flush();

    expect(switchMock).toHaveBeenCalledWith({ id: "usr_a" });
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  it("opens the PIN field with the required attributes and no auto-submit", async () => {
    await mount();
    await choose("Alice");

    const input = document.body.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input).toBe(document.activeElement);
    expect(input.inputMode).toBe("numeric");
    expect(input.pattern).toBe("[0-9]*");
    expect(input.autocomplete).toBe("off");
    expect(input.maxLength).toBe(8);
    await fill("2468");
    expect(switchMock).not.toHaveBeenCalled();

    await act(async () => { button("Switch")!.click(); await Promise.resolve(); });
    expect(switchMock).toHaveBeenCalledWith({ id: "usr_a", pin: "2468" });
  });

  it("shows a wrong PIN in the footer, clears the field and refocuses it", async () => {
    switchMock.mockRejectedValue(new ApiError("Wrong PIN.", 401, undefined, "err.badPin"));
    await mount();
    await choose("Alice");
    const input = document.body.querySelector<HTMLInputElement>(".profile-pin")!;
    await fill("1111");
    await act(async () => { button("Switch")!.click(); await flush(); });

    expect(document.body.querySelector(".dialog-foot .login-error")?.textContent).toBe("Wrong PIN.");
    expect(input.value).toBe("");
    expect(document.activeElement).toBe(input);
  });

  it("counts a 429 down before enabling the primary button", async () => {
    switchMock.mockRejectedValue(new ApiError("Too many", 429, undefined, "err.tooManyAttempts", { seconds: 2 }));
    await mount();
    await choose("Alice");
    await fill("2468");
    await act(async () => { button("Switch")!.click(); await flush(); });

    expect(document.body.textContent).toContain("Try again in 2 s");
    expect(button("Switch")?.disabled).toBe(true);
    await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
    expect(document.body.textContent).toContain("Try again in 1 s");
    await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
    expect(document.body.textContent).not.toContain("Too many failed attempts");
    await fill("2468");
    expect(button("Switch")?.disabled).toBe(false);
  });

  it("forgets a wait when going back, since it belongs to the profile that was refused", async () => {
    switchMock.mockRejectedValue(new ApiError("Too many", 429, undefined, "err.tooManyAttempts", { seconds: 5 }));
    await mount();
    await choose("Alice");
    await fill("2468");
    await act(async () => { button("Switch")!.click(); await flush(); });
    expect(document.body.textContent).toContain("Try again in 5 s");

    await act(async () => { document.body.querySelector<HTMLButtonElement>('[aria-label="Back to profiles"]')!.click(); await flush(); });
    await act(async () => { await new Promise((done) => setTimeout(done, 1100)); });
    expect(document.body.textContent).not.toContain("Try again");

    await choose("Alice");
    await fill("2468");
    expect(button("Switch")?.disabled).toBe(false);
  });

  it("opens a locked PIN directly with the password field and an explanation", async () => {
    profilesMock.mockResolvedValue({ profiles: profiles({ pinLocked: true }) });
    await mount();
    await choose("Alice");

    expect(document.body.querySelector(".profile-pin")).toBeNull();
    expect(document.body.querySelector<HTMLInputElement>(".profile-password")?.autocomplete).toBe("current-password");
    expect(document.body.textContent).toContain("The PIN is locked");
  });

  it("switches from the PIN field to password and sends the password", async () => {
    await mount();
    await choose("Alice");
    await act(async () => { button("Use password instead")!.click(); await Promise.resolve(); });
    expect(document.body.querySelector(".profile-pin")).toBeNull();
    await fill("secret", ".profile-password");
    await act(async () => { button("Switch")!.click(); await Promise.resolve(); });

    expect(switchMock).toHaveBeenCalledWith({ id: "usr_a", password: "secret" });
  });

  it("confirms before showing the profiles when media is running", async () => {
    const { onClose } = await mount(true);
    expect(document.body.textContent).toContain("Switching profile stops the playback");
    expect(document.body.querySelector(".profile-row")).toBeNull();

    await act(async () => { button("Cancel")!.click(); });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
