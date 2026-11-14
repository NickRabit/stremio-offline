import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { setLocale } from "./i18n";
import { AccountSettings } from "./Login";
import type { Session } from "./types";

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

const render = async (session: Session, restricted = false) => {
  const onSession = vi.fn();
  const onNotify = vi.fn();
  const onError = vi.fn();
  await act(async () => {
    root.render(<AccountSettings session={session} onSession={onSession} onNotify={onNotify} onError={onError} restricted={restricted}/>);
  });
  return { onSession, onNotify, onError };
};
const fill = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === text);

describe("AccountSettings profile PIN", () => {
  it("is hidden from an account that is not in the switcher", async () => {
    await render({ username: "bob", role: "user" });
    expect(host.textContent).not.toContain("Profile PIN");
  });

  it("sets a PIN with the current password and updates the session", async () => {
    const setPin = vi.spyOn(api, "setOwnPin").mockResolvedValue({ hasPin: true });
    const { onSession, onNotify } = await render({ username: "bob", role: "user", canSwitch: true, hasPin: false });
    const [password, pin] = host.querySelectorAll<HTMLInputElement>(".profile-own-pin input");
    await fill(password, "account-password");
    await fill(pin, "2468");
    await act(async () => { button("Set PIN")!.click(); await Promise.resolve(); });

    expect(setPin).toHaveBeenCalledWith({ currentPassword: "account-password", pin: "2468" });
    expect(onSession).toHaveBeenCalledWith({ username: "bob", role: "user", canSwitch: true, hasPin: true });
    expect(onNotify).toHaveBeenCalledWith("PIN saved.");
  });

  it("removes an existing PIN and reports the new state", async () => {
    const setPin = vi.spyOn(api, "setOwnPin").mockResolvedValue({ hasPin: false });
    const { onSession, onNotify } = await render({ username: "bob", role: "user", hasPin: true });
    const [password] = host.querySelectorAll<HTMLInputElement>(".profile-own-pin input");
    await fill(password, "account-password");
    await act(async () => { button("Remove PIN")!.click(); await Promise.resolve(); });

    expect(setPin).toHaveBeenCalledWith({ currentPassword: "account-password", pin: null });
    expect(onSession).toHaveBeenCalledWith({ username: "bob", role: "user", hasPin: false });
    expect(onNotify).toHaveBeenCalledWith("PIN removed.");
  });

  it("validates a PIN before sending it and stays hidden in restricted mode", async () => {
    const setPin = vi.spyOn(api, "setOwnPin");
    const { onError } = await render({ username: "bob", role: "user", hasPin: true });
    const [password, pin] = host.querySelectorAll<HTMLInputElement>(".profile-own-pin input");
    await fill(password, "account-password");
    await fill(pin, "12x4");
    await act(async () => { button("Change PIN")!.click(); await Promise.resolve(); });
    expect(setPin).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "A PIN is 4 to 8 digits." }));

    await act(async () => root.unmount());
    root = createRoot(host);
    await render({ username: "bob", role: "user", hasPin: true }, true);
    expect(host.textContent).not.toContain("Profile PIN");
  });
});
