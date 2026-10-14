import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaServerManager } from "./MediaServerManager";
import { setLocale } from "./i18n";
import type { AdminRemoteLibrary, LibraryView, MediaServerConnection, UserAccount } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const connection = (over: Partial<MediaServerConnection> = {}): MediaServerConnection => ({
  id: "mconn_1", provider: "jellyfin", name: "Living room", baseUrl: "https://jelly.example",
  allowLan: false, allowLoopback: false, enabled: true, generation: 1, configured: true, status: "available", ...over,
});
const adminLibrary = (over: Partial<AdminRemoteLibrary> = {}): AdminRemoteLibrary => ({
  id: "rlib_a", connectionId: "mconn_1", remoteId: "lib1", name: "Music videos", type: "mixed",
  enabled: true, order: 0, showOnHome: true, showInContinueWatching: true, allowedUsers: [], ...over,
});
const account: UserAccount = {
  id: "user_1", username: "bob", role: "user", disabled: false, mustChangePassword: false,
  createdAt: "2026-01-01T00:00:00Z", permissions: { downloadToLibrary: false, downloadToDevice: false }, libraries: 0, addons: 0,
};

const localLibrary = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_a", name: "Films", type: "movie", enabled: true, order: 0, addedAt: "2026-01-01T00:00:00.000Z",
  writeArtwork: false, autoScanMetadata: false, unreachable: false, readOnly: false, writable: true,
  defaultMovie: false, defaultSeries: false, titles: 0, files: 0, bytes: 0, ...over,
});

let root: Root;
let host: HTMLDivElement;
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
let connections: MediaServerConnection[];
let libraryRows: AdminRemoteLibrary[];
/** A PATCH the test wants refused, keyed on the row it names. */
let refusePatch: ((id: string) => Response | undefined) | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  patches.length = 0;
  connections = [connection()];
  libraryRows = [adminLibrary()];
  refusePatch = undefined;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/api/media-servers") return json({ connections, keyConfigured: true });
    if (method === "GET" && url.pathname === "/api/media-servers/libraries") return json({ libraries: libraryRows });
    if (method === "GET" && url.pathname === "/api/users") return json([account]);
    const patch = /^\/api\/remote-libraries\/([^/]+)$/.exec(url.pathname);
    if (patch && method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      patches.push({ url: url.pathname, body });
      const refusal = refusePatch?.(patch[1]!);
      if (refusal) return refusal;
      libraryRows = libraryRows.map((row) => row.id === patch[1] ? { ...row, ...body } : row);
      return json(libraryRows.find((row) => row.id === patch[1]));
    }
    return json({}, 404);
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
const selectOption = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
};
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text));

const renderManager = async (localLibraries: LibraryView[] = []) => {
  await act(async () => { root.render(<MediaServerManager onError={vi.fn()} localLibraries={localLibraries}/>); });
  await flush();
};
const render = async (localLibraries: LibraryView[] = []) => {
  await renderManager(localLibraries);
  await click(byText("button", "Edit library")!);
  return document.querySelector(".media-server-library-card")!;
};
const rowNames = () =>
  [...host.querySelectorAll(".media-server-attached .library-admin-title strong")].map((node) => node.textContent);
const orderButton = (name: string, direction: "up" | "down") =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="Move ${name} ${direction}"]`);

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

  it("has no ordering controls now that the overview owns the arrows", async () => {
    libraryRows = [adminLibrary({ id: "rlib_a", name: "Alpha", order: 0 }), adminLibrary({ id: "rlib_b", name: "Beta", order: 1 })];
    const dialog = await render();
    expect(dialog.querySelector(".library-admin-order")).toBeNull();
    expect(dialog.querySelector('button[aria-label^="Move "]')).toBeNull();
  });

  it("offers only the writable local libraries of a fitting kind and saves the copy destination", async () => {
    libraryRows = [adminLibrary({ type: "movie" })];
    const dialog = await render([
      localLibrary({ id: "lib_a", name: "Films" }),
      localLibrary({ id: "lib_b", name: "Shows", type: "series" }),
      localLibrary({ id: "lib_c", name: "Box", type: "mixed" }),
      localLibrary({ id: "lib_d", name: "Locked", writable: false, readOnly: true }),
    ]);
    const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Save copies to"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Default for this library type", "Films", "Box",
    ]);
    expect(select.value).toBe("");
    await selectOption(select, "lib_c");
    await click(byText(".dialog-foot button", "Save")!);
    expect(patches[0]!.body).toMatchObject({ downloadLibraryId: "lib_c" });
  });

  it("clears the override with the default option and shows the hint", async () => {
    libraryRows = [adminLibrary({ type: "movie", downloadLibraryId: "lib_a" })];
    const dialog = await render([localLibrary({ id: "lib_a", name: "Films" })]);
    expect(dialog.textContent).toContain("Movies use the default movie library, series the default series library, and other content a general-purpose library.");
    const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Save copies to"]')!;
    expect(select.value).toBe("lib_a");
    await selectOption(select, "");
    await click(byText(".dialog-foot button", "Save")!);
    expect(patches[0]!.body).toMatchObject({ downloadLibraryId: null });
  });

  it("keeps the choice and the dialog when the change is refused", async () => {
    libraryRows = [adminLibrary({ type: "movie" })];
    refusePatch = () => json({ error: "The media-server copy destination is malformed." }, 400);
    const dialog = await render([localLibrary({ id: "lib_a", name: "Films" })]);
    const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Save copies to"]')!;
    await selectOption(select, "lib_a");
    await click(byText(".dialog-foot button", "Save")!);
    expect(document.querySelector(".media-server-library-card")).not.toBeNull();
    expect(dialog.textContent).toContain("The media-server copy destination is malformed.");
    expect(select.value).toBe("lib_a");
  });

  it("keeps a stored destination it can no longer offer visible and selected", async () => {
    libraryRows = [adminLibrary({ type: "movie", downloadLibraryId: "lib_gone" })];
    const dialog = await render([localLibrary({ id: "lib_a", name: "Films" })]);
    const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Save copies to"]')!;
    expect(select.value).toBe("lib_gone");
    const stored = [...select.options].find((option) => option.value === "lib_gone")!;
    expect(stored.disabled).toBe(true);
    expect(stored.textContent).toBe("lib_gone · Unavailable");
    expect(byText(".dialog-foot button", "Save")).toHaveProperty("disabled", true);
  });

  it("names a stored destination that is still here but no longer writable", async () => {
    libraryRows = [adminLibrary({ type: "movie", downloadLibraryId: "lib_a" })];
    const dialog = await render([localLibrary({ id: "lib_a", name: "Films", writable: false, readOnly: true })]);
    const select = dialog.querySelector<HTMLSelectElement>('select[aria-label="Save copies to"]')!;
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Default for this library type", "Films · Unavailable",
    ]);
    expect(select.value).toBe("lib_a");
  });
});

describe("Remote library ordering", () => {
  it("draws every attached library in one global order, across connections", async () => {
    connections = [connection(), connection({ id: "mconn_2", name: "Attic", provider: "emby" })];
    libraryRows = [
      adminLibrary({ id: "rlib_a", connectionId: "mconn_1", name: "Alpha", order: 0 }),
      adminLibrary({ id: "rlib_b", connectionId: "mconn_2", name: "Beta", order: 1 }),
    ];
    await renderManager();
    expect(rowNames()).toEqual(["Alpha", "Beta"]);
  });

  it("hides the arrows while a single library is attached", async () => {
    await renderManager();
    expect(host.querySelector(".media-server-attached .library-admin-order")).toBeNull();
  });

  it("moves one row across servers and rewrites the whole sequence", async () => {
    connections = [connection(), connection({ id: "mconn_2", name: "Attic", provider: "emby" })];
    libraryRows = [
      adminLibrary({ id: "rlib_a", connectionId: "mconn_1", name: "Alpha", order: 0 }),
      adminLibrary({ id: "rlib_b", connectionId: "mconn_2", name: "Beta", order: 1 }),
    ];
    await renderManager();
    expect(orderButton("Alpha", "up")?.disabled).toBe(true);
    expect(orderButton("Beta", "down")?.disabled).toBe(true);

    await click(orderButton("Alpha", "down")!);
    expect(patches).toEqual([
      { url: "/api/remote-libraries/rlib_b", body: { order: 0 } },
      { url: "/api/remote-libraries/rlib_a", body: { order: 1 } },
    ]);
    expect(rowNames()).toEqual(["Beta", "Alpha"]);
  });

  it("normalises duplicate and gapped orders when it moves a row", async () => {
    libraryRows = [
      adminLibrary({ id: "rlib_a", name: "Alpha", order: 5 }),
      adminLibrary({ id: "rlib_b", name: "Beta", order: 5 }),
      adminLibrary({ id: "rlib_c", name: "Gamma", order: 9 }),
    ];
    await renderManager();
    expect(rowNames()).toEqual(["Alpha", "Beta", "Gamma"]);
    await click(orderButton("Alpha", "down")!);
    expect(patches).toEqual([
      { url: "/api/remote-libraries/rlib_b", body: { order: 0 } },
      { url: "/api/remote-libraries/rlib_a", body: { order: 1 } },
      { url: "/api/remote-libraries/rlib_c", body: { order: 2 } },
    ]);
    expect(rowNames()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("reports a refused reorder through the toast and keeps the persisted order", async () => {
    const onError = vi.fn();
    connections = [connection(), connection({ id: "mconn_2", name: "Attic", provider: "emby" })];
    libraryRows = [
      adminLibrary({ id: "rlib_a", connectionId: "mconn_1", name: "Alpha", order: 0 }),
      adminLibrary({ id: "rlib_b", connectionId: "mconn_2", name: "Beta", order: 1 }),
    ];
    refusePatch = () => json({ error: "refused", messageKey: "err.mediaServerBusy" }, 409);
    await act(async () => { root.render(<MediaServerManager onError={onError}/>); });
    await flush();

    await click(orderButton("Alpha", "down")!);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][0] as { status: number }).status).toBe(409);
    expect(patches, "the first refusal stops the run").toHaveLength(1);
    expect(document.querySelector(".media-server-library-card"), "the failure is not hidden in a dialog").toBeNull();
    expect(rowNames(), "the list is re-read and shows the order the server kept").toEqual(["Alpha", "Beta"]);
  });
});

it("clears a failed reorder reload after the next successful move", async () => {
  libraryRows = [adminLibrary({ id: "rlib_a", name: "Alpha", order: 0 }), adminLibrary({ id: "rlib_b", name: "Beta", order: 1 })];
  const original = fetch;
  let reads = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(input), "http://localhost").pathname === "/api/media-servers/libraries" && ++reads === 2) {
      return json({ error: "Inventory unavailable" }, 503);
    }
    return original(input, init);
  }));
  await renderManager();
  await click(orderButton("Alpha", "down")!);
  expect(host.querySelector('.remote-error[role="alert"]')).not.toBeNull();
  await click(orderButton("Alpha", "down")!);
  expect(host.querySelector('.remote-error[role="alert"]')).toBeNull();
});
