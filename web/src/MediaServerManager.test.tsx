import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaServerManager } from "./MediaServerManager";
import { setLocale } from "./i18n";
import type { AdminRemoteLibrary, MediaServerConnection, UserAccount } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const connection: MediaServerConnection = {
  id: "mconn_1", provider: "jellyfin", name: "Living room", baseUrl: "https://jelly.example",
  allowLan: false, allowLoopback: false, enabled: true, generation: 1, configured: true, status: "available",
};
const adminLibrary = (over: Partial<AdminRemoteLibrary> = {}): AdminRemoteLibrary => ({
  id: "rlib_a", connectionId: "mconn_1", remoteId: "lib1", name: "Music videos", type: "mixed",
  enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, allowedUsers: [], ...over,
});
const account: UserAccount = {
  id: "user_1", username: "bob", role: "user", disabled: false, mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00Z", permissions: { downloadToLibrary: false, downloadToDevice: false }, libraries: 0, addons: 0,
};

let root: Root;
let host: HTMLDivElement;
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
let current = adminLibrary();

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  patches.length = 0;
  current = adminLibrary();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/media-servers") return Promise.resolve(json({ connections: [connection], keyConfigured: true }));
    if (url.pathname === "/api/media-servers/libraries") return Promise.resolve(json({ libraries: [current] }));
    if (url.pathname === "/api/users") return Promise.resolve(json([account]));
    if (url.pathname.startsWith("/api/remote-libraries/")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      patches.push({ url: url.pathname, body });
      return Promise.resolve(json({ ...current, ...body }));
    }
    return Promise.resolve(json({}, 404));
  }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });
const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); await flush(); };
const byText = (selector: string, text: string) =>
  [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));

const render = async () => {
  await act(async () => { root.render(<MediaServerManager onError={vi.fn()}/>); });
  await flush();
  await click(byText("button", "Remote library")!);
  return host.querySelector(".media-server-library-card")!;
};

describe("RemoteLibraryDialog", () => {
  it("saves the shared display settings and the browse mode", async () => {
    const dialog = await render();
    await click(byText(".library-check", "Show a mosaic of covers")!);
    const mode = dialog.querySelector<HTMLSelectElement>('select[aria-label="Browse"]')!;
    await act(async () => {
      mode.value = "titles";
      mode.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click(byText(".dialog-foot button", "Save")!);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe("/api/remote-libraries/rlib_a");
    expect(patches[0]!.body).toMatchObject({ browseMode: "titles", mosaic: false, showInFavorites: true });
  });

  it("keeps the shared concepts and leaves out the filesystem-only controls", async () => {
    const dialog = await render();
    const controls = [...dialog.querySelectorAll(".library-check")].map((node) => node.textContent ?? "");
    expect(controls.some((text) => text.includes("Show in Favourites"))).toBe(true);
    expect(controls.some((text) => text.includes("Show a mosaic of covers"))).toBe(true);
    expect(dialog.querySelector('select[aria-label="Browse"]')).not.toBeNull();
    const text = dialog.textContent ?? "";
    expect(text).not.toContain("Write artwork next to the media");
    expect(text).not.toContain("Automatically look up metadata");
    expect(text).not.toContain("Default for movies");
  });
});
