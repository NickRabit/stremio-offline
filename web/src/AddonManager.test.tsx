import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AddonManager } from "./AddonManager";
import type { Addon, LibraryView } from "./types";
import { setLocale } from "./i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  fetchMock = vi.fn().mockResolvedValue(json({ manifestUrl: "https://addon.test/abc123/manifest.json", role: "source" }));
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

const addon = (over: Partial<Addon> = {}): Addon => ({
  key: "a1", role: "source", enabled: true, globalSearch: true, showInContinueWatching: true,
  displayUrl: "https://addon.test/…/manifest.json",
  downloadSettings: { movie: { subfolder: "", layout: "structured" }, series: { subfolder: "", layout: "structured" } },
  manifest: { id: "org.test", name: "Test source", version: "1.0.0", description: "Streams things", resources: ["stream"] },
  ...over,
});

const library: LibraryView = {
  id: "lib_1", name: "Films", type: "movie", root: "/downloads/Films", enabled: true, order: 0,
  addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: true, unreachable: false, readOnly: false,
  defaultMovie: true, defaultSeries: false, titles: 1, files: 1, bytes: 1,
};

const render = async (addons: Addon[], props: Partial<Parameters<typeof AddonManager>[0]> = {}) => {
  await act(async () => {
    root.render(<AddonManager addons={addons} libraries={[library]} onChanged={async () => undefined}
      onNotify={vi.fn()} onError={vi.fn()} {...props}/>);
  });
  await act(async () => { await Promise.resolve(); });
};

const button = (name: string) => [...host.querySelectorAll("button")].find((element) => element.textContent?.includes(name));
const openEditor = async () => {
  await act(async () => { button("Edit addon")!.click(); });
  await act(async () => { await Promise.resolve(); });
};

it("the card is a summary: no setting is editable without opening the dialog", async () => {
  await render([addon()]);
  const card = host.querySelector(".addon-card")!;
  // The on/off switch is the one list action; everything else lives behind Edit addon.
  expect(card.querySelectorAll("input[type=checkbox]")).toHaveLength(1);
  expect(card.querySelectorAll("select")).toHaveLength(0);
  expect(card.textContent).toContain("1.0.0");
});

it("an addon that is switched off says so instead of looking the same", async () => {
  await render([addon({ enabled: false })]);
  expect(host.querySelector(".addon-card")!.textContent).toContain("off");
});

it("a catalogue kept out of global search says so on the card", async () => {
  await render([addon({ role: "catalog", globalSearch: false, manifest: { ...addon().manifest, resources: ["catalog"], catalogs: [{ id: "top", type: "movie" }] } })]);
  const card = host.querySelector(".addon-card")!;
  expect(card.textContent).toContain("outside search");
  expect(card.textContent).toContain("1 catalog");
});

it("restricted mode renders the summary without the switch or the editor", async () => {
  await render([addon()], { restricted: true });
  expect(host.querySelector(".addon-card input")).toBeNull();
  expect(button("Edit addon")).toBeUndefined();
});

it("an ordinary user reorders their own list and is told the order is theirs alone", async () => {
  const second = addon({ key: "a2", manifest: { ...addon().manifest, id: "org.test2", name: "Second source" } });
  await render([addon(), second], { admin: false });
  expect(host.textContent).toContain("This order is yours alone.");
  expect(button("Edit addon")).toBeUndefined();
  expect(host.querySelector(".addon-card input")).toBeNull();

  fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
  const down = host.querySelectorAll<HTMLButtonElement>(".addon-card .addon-order button")[1]!;
  await act(async () => { down.click(); });
  await act(async () => { await Promise.resolve(); });
  const put = fetchMock.mock.calls.find(([, init]) => init?.method === "PUT")!;
  expect(put[0]).toBe("/api/addons/order");
  expect(JSON.parse(put[1].body as string)).toEqual({ order: ["a2", "a1"] });
});

it("the dialog fetches the real address, which the list hides", async () => {
  await render([addon()]);
  await openEditor();
  expect(fetchMock.mock.calls[0][0]).toContain("/api/addons/a1/export");
  const url = host.querySelector<HTMLInputElement>(".addon-edit-card input[type=text], .addon-edit-card .manifest-field input")!;
  expect(url.value).toBe("https://addon.test/abc123/manifest.json");
});

it("saving is refused until something actually changed", async () => {
  await render([addon()]);
  await openEditor();
  const save = button("Save changes") as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  const subfolder = host.querySelector<HTMLInputElement>(".download-rule input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(subfolder, "Films");
    subfolder.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect((button("Save changes") as HTMLButtonElement).disabled).toBe(false);
});

it("one save carries every staged change in a single request", async () => {
  await render([addon()]);
  await openEditor();
  const subfolder = host.querySelector<HTMLInputElement>(".download-rule input")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(subfolder, "Films");
    subfolder.dispatchEvent(new Event("input", { bubbles: true }));
  });
  fetchMock.mockResolvedValue(json(addon()));
  await act(async () => { button("Save changes")!.click(); });
  await act(async () => { await Promise.resolve(); });
  const patches = fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH");
  expect(patches).toHaveLength(1);
  const body = JSON.parse(patches[0][1].body as string);
  expect(body.downloadSettings.movie.subfolder).toBe("Films");
  // Nothing that did not change is sent along.
  expect(body).not.toHaveProperty("role");
  expect(body).not.toHaveProperty("url");
});

it("a stream-only addon has no catalogue switches to set", async () => {
  await render([addon()]);
  await openEditor();
  expect(host.textContent).not.toContain("Behaviour");
  expect(host.textContent).toContain("Where to store files");
});

it("a catalogue addon has the switches but no storage rules", async () => {
  await render([addon({ role: "catalog", manifest: { ...addon().manifest, resources: ["catalog"] } })]);
  await openEditor();
  expect(host.textContent).toContain("Behaviour");
  expect(host.textContent).not.toContain("Where to store files");
});

it("Cinemeta cannot be switched off, demoted to sources, or removed", async () => {
  await render([addon({ role: "both", essential: true, manifest: { ...addon().manifest, resources: ["catalog", "stream"] } })]);
  expect(host.querySelector<HTMLInputElement>(".addon-card input")!.disabled).toBe(true);
  await openEditor();
  const roles = [...host.querySelectorAll<HTMLOptionElement>(".addon-edit-card option")].map((option) => option.value);
  expect(roles).not.toContain("source");
  expect(button("Remove addon")).toBeUndefined();
});

it("the filter only appears once the list is long enough to need it", async () => {
  const many = Array.from({ length: 9 }, (_, index) => addon({ key: `a${index}`, manifest: { ...addon().manifest, name: `Source ${index}` } }));
  await render([addon({ key: "solo", manifest: { ...addon().manifest, name: "Solo" } })]);
  expect(host.querySelector(".addon-filter")).toBeNull();
  await render(many);
  expect(host.querySelector(".addon-filter")).not.toBeNull();
});

it("filtering hides the other cards and locks the priority arrows", async () => {
  const many = Array.from({ length: 9 }, (_, index) => addon({ key: `a${index}`, manifest: { ...addon().manifest, name: `Source ${index}` } }));
  await render(many);
  const filter = host.querySelector<HTMLInputElement>(".addon-filter")!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(filter, "Source 7");
    filter.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(host.querySelectorAll(".addon-card")).toHaveLength(1);
  // Moving by one place while eight rows are hidden would land somewhere nobody chose.
  expect([...host.querySelectorAll<HTMLButtonElement>(".addon-order button")].every((element) => element.disabled)).toBe(true);
});

/** The editor scrolled as one block, so the settings took the save button off the bottom of a
 *  short window. One scroll region, with the head and the action outside it. */
it("keeps the head and the save action outside the one scrolling region", async () => {
  await render([addon()]);
  await openEditor();

  const card = host.querySelector(".addon-edit-card")!;
  const body = card.querySelector(".dialog-body")!;
  expect(card.classList.contains("dialog-split")).toBe(true);
  expect(body.querySelector(".identify-head"), "the head is pinned outside the scroller").toBeNull();
  const save = button("Save changes")!;
  expect(save.closest(".dialog-foot"), "the action is pinned outside the scroller").toBeTruthy();
  expect(save.closest(".dialog-body")).toBeNull();
});
