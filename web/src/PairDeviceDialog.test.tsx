import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { PairDeviceDialog } from "./PairDeviceDialog";
import { setLocale } from "./i18n";
import type { Session } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const preview = {
  code: "ABCD2345",
  deviceLabel: "Bedroom <TV>",
  username: "owner",
  nonce: "n".repeat(43),
  expiresIn: 280,
};

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;
const session: Session = { username: "owner", role: "admin" };

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const mount = async (onClose = vi.fn(), onNotify = vi.fn()) => {
  await act(async () => {
    root.render(<PairDeviceDialog session={session} onClose={onClose} onNotify={onNotify}/>);
  });
  return { onClose, onNotify };
};

const changeCode = async (value: string) => {
  const input = document.body.querySelector<HTMLInputElement>('input[autocomplete="off"]')!;
  const window = (globalThis as { jsdom?: { window: Window } }).jsdom?.window ?? globalThis;
  const view = window as unknown as typeof globalThis;
  const descriptor = Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, "value")!;
  await act(async () => {
    descriptor.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const button = (label: string) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === label);

describe("PairDeviceDialog", () => {
  it("inspects first and approves only after an explicit click", async () => {
    const onClose = vi.fn();
    const onNotify = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/api/auth/pair/inspect")) return Promise.resolve(json(preview));
      if (String(url).endsWith("/api/auth/pair/approve")) return Promise.resolve(new Response(null, { status: 204 }));
      throw new Error(`unexpected ${url}`);
    });
    await mount(onClose, onNotify);
    await changeCode("abcd-2345");
    await act(async () => { button("Continue")!.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain("Bedroom <TV>");
    expect(document.body.textContent).toContain("owner");
    expect(document.body.textContent).toContain("ABCD 2345");
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/approve"))).toBe(false);

    await act(async () => { button("Sign in this device")!.click(); await Promise.resolve(); });
    const approve = fetchMock.mock.calls.find((call) => String(call[0]).includes("/approve"));
    expect(approve?.[1]).toMatchObject({ method: "POST", headers: { "x-pairing-intent": "approve" } });
    expect(JSON.parse(String((approve?.[1] as RequestInit).body))).toEqual({ code: preview.code, nonce: preview.nonce });
    expect(onNotify).toHaveBeenCalledWith("Device approved. Finish signing in on the TV.");
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores a lookup superseded by a code edit", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    await mount();
    await changeCode("ABCD2345");
    await act(async () => { button("Continue")!.click(); });
    await changeCode("ABCD2346");
    await act(async () => { resolve(json(preview)); await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).not.toContain("Bedroom <TV>");
    expect(button("Sign in this device")).toBeUndefined();
    expect(button("Continue")).toBeTruthy();
  });

  it("does not consume a late lookup after the dialog closes", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    const onClose = vi.fn();
    await mount(onClose);
    await changeCode("ABCD2345");
    await act(async () => { button("Continue")!.click(); });
    await act(async () => { button("Cancel")!.click(); });
    expect(onClose).toHaveBeenCalled();
    await act(async () => { resolve(json(preview)); await Promise.resolve(); });
    expect(document.body.querySelector(".pair-device-code")).toBeNull();
  });

  it("renders a translated terminal error and offers a retry", async () => {
    setLocale("cs");
    fetchMock.mockResolvedValue(json({
      error: "This code is invalid or no longer available.",
      messageKey: "err.pairInvalid",
    }, 410));
    await mount();
    await changeCode("ABCD2345");
    await act(async () => { button("Pokračovat")!.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain("Tento kód není platný nebo již není dostupný.");
    const retry = button("Zkusit znovu");
    expect(retry).toBeTruthy();
    await act(async () => { retry!.click(); });
    expect(document.body.querySelector<HTMLInputElement>('input[autocomplete="off"]')?.value).toBe("");
  });

  it("denies the inspected code without approving it", async () => {
    const onClose = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).endsWith("/inspect")) return Promise.resolve(json(preview));
      if (String(url).endsWith("/deny")) return Promise.resolve(new Response(null, { status: 204 }));
      return Promise.resolve(json({}, 500));
    });
    await mount(onClose);
    await changeCode("ABCD2345");
    await act(async () => { button("Continue")!.click(); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { button("Deny")!.click(); await Promise.resolve(); });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/approve"))).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith("/deny"))).toBe(true);
    expect(onClose).toHaveBeenCalled();
  });
});
