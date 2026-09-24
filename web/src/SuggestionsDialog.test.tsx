import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SuggestionsDialog } from "./SuggestionsDialog";
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

const rows = {
  items: [{
    key: "Father Ted", label: "Father Ted", libraryId: "lib_00000001", library: "Serials", path: "Father Ted",
    suggestion: { type: "series", id: "tt0111958", name: "Father Ted", year: 1995, score: 78, titleSimilarity: 88, reason: "year", poster: "img_1" },
  }],
  total: 1,
};

describe("SuggestionsDialog", () => {
  it("confirms a suggestion and drops the row", async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(rows));
      if (String(url).includes("/api/library/match")) return Promise.resolve(json({ key: "Father Ted", type: "series", id: "tt0111958" }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={onChanged} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Father Ted");
    const confirm = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Confirm"));
    await act(async () => { confirm!.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/api/library/match"));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toMatchObject({ path: "Father Ted", id: "tt0111958", type: "series" });
    expect(onChanged).toHaveBeenCalled();
    expect(host.textContent).toContain("Nothing is waiting");
  });

  it("dismisses a suggestion through the delete endpoint", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(rows));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={() => undefined} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const dismiss = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Dismiss"));
    await act(async () => { dismiss!.click(); });
    await act(async () => { await Promise.resolve(); });
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/api/library/suggestion?"));
    expect(call?.[1]).toMatchObject({ method: "DELETE" });
  });
});

describe("SuggestionsDialog review context", () => {
  const render = async (payload: unknown, libraryId?: string) => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(payload));
      return Promise.resolve(json({}));
    });
    await act(async () => {
      root.render(libraryId
        ? <SuggestionsDialog libraryId={libraryId} onClose={() => undefined} onChanged={() => undefined} onIdentify={() => undefined}/>
        : <SuggestionsDialog onClose={() => undefined} onChanged={() => undefined} onIdentify={() => undefined}/>);
    });
    await act(async () => { await Promise.resolve(); });
  };

  it("names the library and the folder, and calls the score what it is", async () => {
    await render(rows);
    expect(host.textContent).toContain("Serials · Father Ted");
    expect(host.textContent).toContain("Title similarity 88%");
    expect(host.textContent).toContain("Check the release year.");
    expect(host.textContent).not.toContain("match 88%");
  });

  it("asks only for the library it was scoped to", async () => {
    await render(rows, "lib_00000001");
    const call = fetchMock.mock.calls.find((entry) => String(entry[0]).includes("/api/library/suggestions"));
    expect(String(call?.[0])).toContain("libraryId=lib_00000001");
  });

  it("shows a correction as the current title beside the proposed one", async () => {
    await render({
      items: [{
        key: "Flashdance", label: "Flashdance", library: "Films", path: "Flashdance",
        suggestion: {
          type: "movie", id: "tt0085549", name: "Flashdance", year: 1983, score: 100, titleSimilarity: 100, reason: "correction",
          replacesId: "tt-old", replacesName: "Flashdance (wrong row)", replacesYear: 2011,
        },
      }],
      total: 1,
    });
    expect(host.textContent).toContain("Current: Flashdance (wrong row) (2011); proposed: Flashdance (1983)");
    expect(host.textContent).toContain("Confirm");
  });

  it("shows a more-than-one-title reason for an ambiguous proposal", async () => {
    await render({
      items: [{ key: "Avengers", label: "Avengers", suggestion: { type: "movie", id: "tt0848228", name: "The Avengers", year: 2012, score: 100, titleSimilarity: 100, reason: "ambiguous" } }],
      total: 1,
    });
    expect(host.textContent).toContain("More than one title may match.");
    expect(host.textContent).toContain("Title similarity 100%");
  });

  it("shows the candidate's own poster", async () => {
    await render(rows);
    const image = host.querySelector<HTMLImageElement>(".suggestion-thumb img");
    expect(image?.getAttribute("src")).toBe("img_1");
    expect(image?.getAttribute("alt")).toBe("Poster for Father Ted");
    expect(host.querySelector(".suggestion-placeholder")).toBeTruthy();
  });

  it("keeps the neutral poster placeholder when the candidate image fails", async () => {
    await render(rows);
    const image = host.querySelector<HTMLImageElement>(".suggestion-thumb img")!;
    await act(async () => { image.dispatchEvent(new Event("error")); });
    expect(image.classList.contains("broken")).toBe(true);
    expect(host.querySelector(".suggestion-placeholder")).toBeTruthy();
  });

  it("shows a placeholder for a legacy row without a poster, and costs no extra request", async () => {
    await render({
      items: [{ key: "Heat", label: "Heat", suggestion: { type: "movie", id: "tt0113277", name: "Heat", score: 91 } }],
      total: 1,
    });
    expect(host.querySelector(".suggestion-thumb img")).toBeNull();
    const placeholder = host.querySelector(".suggestion-placeholder");
    expect(placeholder).toBeTruthy();
    expect(placeholder?.getAttribute("aria-label")).toBe("Poster unavailable");
    expect(host.textContent).toContain("Check this match before confirming.");
    expect(host.textContent).toContain("Previous scan score 91%");
    const suggestionCalls = fetchMock.mock.calls.filter((entry) => String(entry[0]).includes("/api/library/suggestions"));
    expect(suggestionCalls.length).toBe(1); // a missing poster costs no extra request
  });

  it("keeps the confirm and dismiss actions explicit and renders no row for an empty answer", async () => {
    await render({ items: [], total: 0 });
    expect(host.textContent).toContain("Nothing is waiting");
    const actions = [...host.querySelectorAll(".suggestion-actions button")];
    expect(actions).toHaveLength(0);
  });

  it("shows a part-conflict reason and the competing candidates beside the proposal", async () => {
    await render({
      items: [{
        key: "Twilight", label: "Twilight", library: "Films", path: "Twilight",
        suggestion: {
          type: "movie", id: "tt1099212", name: "Twilight", year: 2008, score: 100, titleSimilarity: 100, reason: "part",
          alternatives: [
            { type: "movie", id: "tt1324999", name: "The Twilight Saga: Breaking Dawn", year: 2011, score: 84, titleSimilarity: 78 },
          ],
        },
      }],
      total: 1,
    });
    expect(host.textContent).toContain("part or sequel");
    expect(host.textContent).toContain("Other candidates:");
    expect(host.textContent).toContain("The Twilight Saga: Breaking Dawn (2011) · title similarity 78%");
  });

  it("lets only the topmost dialog handle Escape and the backdrop", async () => {
    const onClose = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json(rows));
      return Promise.resolve(json({}));
    });
    await act(async () => {
      root.render(<SuggestionsDialog identifyPath="Father Ted" onClose={onClose} onChanged={() => undefined} onIdentify={() => undefined}/>);
    });
    await act(async () => { await Promise.resolve(); });
    // The identify dialog sits above this one: its own handler closes it, not this.
    await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); });
    expect(onClose).not.toHaveBeenCalled();
    const overlay = host.querySelector(".identify-overlay")!;
    await act(async () => { overlay.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    expect(host.textContent).toContain("Father Ted");
  });

  it("removes only the applied row and keeps the rest of the list", async () => {
    const onChanged = vi.fn();
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) return Promise.resolve(json({
        items: [
          { key: "Heat", label: "Heat", suggestion: { type: "movie", id: "tt0113277", name: "Heat", score: 92 } },
          { key: "Ronin", label: "Ronin", suggestion: { type: "movie", id: "tt0122690", name: "Ronin", score: 88 } },
        ],
        total: 2,
      }));
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={onChanged} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Heat");
    expect(host.textContent).toContain("Ronin");
    await act(async () => { root.render(<SuggestionsDialog appliedKey="Heat" onClose={() => undefined} onChanged={onChanged} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    expect(host.textContent).toContain("Ronin");
    expect(host.textContent).not.toContain("Heat");
    expect(onChanged).toHaveBeenCalled();
  });

  it("takes an applied row out once, even while the parent keeps re-rendering", async () => {
    const first = vi.fn();
    const second = vi.fn();
    let suggestionLoads = 0;
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("/api/library/suggestions")) {
        suggestionLoads += 1;
        return Promise.resolve(json({
          items: [
            { key: "Heat", label: "Heat", suggestion: { type: "movie", id: "tt0113277", name: "Heat", score: 92 } },
            { key: "Ronin", label: "Ronin", suggestion: { type: "movie", id: "tt0122690", name: "Ronin", score: 88 } },
          ],
          total: 2,
        }));
      }
      return Promise.resolve(json({}));
    });
    await act(async () => { root.render(<SuggestionsDialog onClose={() => undefined} onChanged={() => undefined} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    const list = host.querySelector(".suggestion-list")!;

    await act(async () => { root.render(<SuggestionsDialog appliedKey="Heat" onClose={() => undefined} onChanged={first} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });
    // The parent re-renders with the same answer but a fresh callback, as an inline one does.
    await act(async () => { root.render(<SuggestionsDialog appliedKey="Heat" onClose={() => undefined} onChanged={second} onIdentify={() => undefined}/>); });
    await act(async () => { await Promise.resolve(); });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(suggestionLoads).toBe(1);
    expect(host.querySelector(".suggestion-list")).toBe(list);
    expect(host.textContent).toContain("Ronin");
    expect(host.textContent).not.toContain("Heat");
  });
});
