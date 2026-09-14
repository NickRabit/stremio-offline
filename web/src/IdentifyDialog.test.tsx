import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { IdentifyDialog } from "./IdentifyDialog";
import { setLocale } from "./i18n";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

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

const identity = {
  path: "Father Ted",
  key: "Father Ted",
  file: false,
  label: "Father Ted",
  kind: "series" as const,
  parsed: { title: "Father Ted", query: "Father Ted", year: 1995 },
  match: "unmatched" as const,
  suggestion: { type: "series", id: "tt0111958", name: "Father Ted", year: 1995, score: 92 },
};

const episodeIdentity = {
  ...identity,
  path: "Father Ted/dil.mkv",
  file: true,
  label: "dil.mkv",
  parsed: { title: "Father Ted", query: "Father Ted", year: 1995, season: 1, episode: 2 },
  suggestion: undefined,
};

const seriesMeta = {
  id: "tt0111958", type: "series", name: "Father Ted",
  videos: [
    { season: 1, episode: 1, name: "Good Luck" },
    { season: 1, episode: 2, name: "Entertaining Father Stone" },
  ],
};

describe("IdentifyDialog", () => {
  it("prefills series kind and searches", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(identity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector("input")?.value).toBe("Father Ted");
    expect(host.textContent).toContain("Series");
    expect(host.textContent).toContain("Father Ted");
    const searchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/search"));
    expect(String(searchCall?.[0])).toContain("type=series");
  });

  it("applies the picked title", async () => {
    const onApplied = vi.fn();
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(identity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      if (String(url).includes("/api/library/match")) return Promise.resolve(json({ key: "Father Ted", type: "series", id: "tt0111958" }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={onApplied}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Use this title"));
    expect(apply).toBeTruthy();
    await act(async () => { apply!.click(); });
    await act(async () => { await Promise.resolve(); });
    const matchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/library/match"));
    expect(matchCall?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String((matchCall?.[1] as RequestInit).body))).toMatchObject({ path: "Father Ted", id: "tt0111958", type: "series" });
    expect(onApplied).toHaveBeenCalled();
  });

  it("binds one file to a chosen episode", async () => {
    const onApplied = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(episodeIdentity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      if (String(url).includes("/api/meta/")) return Promise.resolve(json(seriesMeta));
      if (String(url).includes("/api/library/match")) return Promise.resolve(json({ key: "Father Ted/dil.mkv", type: "series", id: "tt0111958" }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted/dil.mkv" onClose={() => undefined} onApplied={onApplied}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // Nothing is preselected without a suggestion: the user picks the title first.
    expect(host.querySelector(".identify-results button.selected")).toBeNull();
    const hit = [...host.querySelectorAll(".identify-results button")][0] as HTMLButtonElement;
    await act(async () => { hit.click(); });
    const onlyThisFile = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("This file only"));
    await act(async () => { onlyThisFile!.click(); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const episodeSelect = [...host.querySelectorAll("select")].at(-1)!;
    expect(episodeSelect.textContent).toContain("Entertaining Father Stone");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(episodeSelect, "2");
      episodeSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Use this title"));
    await act(async () => { apply!.click(); });
    await act(async () => { await Promise.resolve(); });
    const matchCall = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/library/match"));
    expect(JSON.parse(String((matchCall?.[1] as RequestInit).body)))
      .toMatchObject({ path: "Father Ted/dil.mkv", id: "tt0111958", scope: "file", season: 1, episode: 2 });
    expect(onApplied).toHaveBeenCalled();
  });

  it("shows the locked hint when the title was unmatched", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json({ ...identity, match: "rejected" }));
      if (String(url).includes("/api/search")) return Promise.resolve(json({ items: [], hasMore: false, cursor: "", sources: 1 }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" onClose={() => undefined} onApplied={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("excluded from matching");
  });

  it("queues one catalogue match for several selected items", async () => {
    const onApplied = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/identity")) return Promise.resolve(json(identity));
      if (String(url).includes("/api/search")) return Promise.resolve(json({
        items: [{ id: "tt0111958", type: "series", name: "Father Ted", releaseInfo: "1995" }],
        hasMore: false, cursor: "", sources: 1,
      }));
      if (String(url).includes("/api/library/ops")) return Promise.resolve(json({ id: "job-1" }, 202));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<IdentifyDialog path="Father Ted" paths={["Father Ted", "Other"]} onClose={() => undefined} onApplied={onApplied}/>); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll(".identify-results button")][0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await act(async () => { [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Use this title"))!.click(); });
    await act(async () => { await Promise.resolve(); });
    const post = fetchMock.mock.calls.find((call) => String(call[0]).includes("/api/library/ops"));
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ op: "match", items: ["Father Ted", "Other"], id: "tt0111958", type: "series" });
    expect(onApplied).toHaveBeenCalled();
  });
});
