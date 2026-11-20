import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RenamePatternDialog } from "./RenamePatternDialog";
import { setLocale } from "./i18n";
import type { LibraryOp, RenamePlanRow } from "./types";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PATHS = ["Films/One", "Shows/Two"];
const DEFAULT_MOVIE = "{title} ({year})";
const DEFAULT_EPISODE = "{title} - S{season:2}E{episode:2}";

const row = (over: Partial<RenamePlanRow> & Pick<RenamePlanRow, "key" | "from" | "status">): RenamePlanRow => ({
  isFile: true, kind: "movie", sidecars: 0, ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;
let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  localStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  });
};

const planPosts = () => fetchMock.mock.calls
  .filter(([url]) => String(url).includes("/api/library/rename-plan"))
  .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

const fill = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

async function open(options?: {
  paths?: string[];
  rows?: RenamePlanRow[];
  fetchImpl?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
  onStart?: (operations: LibraryOp[]) => void;
  onClose?: () => void;
}) {
  const onStart = vi.fn(options?.onStart);
  const onClose = vi.fn(options?.onClose);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const override = options?.fetchImpl?.(String(url), init);
    if (override) return override;
    if (String(url).includes("/api/library/rename-plan")) return json({ rows: options?.rows ?? [] });
    return json({});
  });
  await act(async () => {
    root.render(<RenamePatternDialog paths={options?.paths ?? PATHS} onClose={onClose} onStart={onStart}/>);
  });
  await flush();
  return { onStart, onClose };
}

describe("RenamePatternDialog", () => {
  it("opens with the default patterns (or the stored pair) and posts them with all paths", async () => {
    await open();
    const movie = host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!;
    const episode = host.querySelector<HTMLInputElement>('input[aria-label="Series episodes"]')!;
    expect(movie.value).toBe(DEFAULT_MOVIE);
    expect(episode.value).toBe(DEFAULT_EPISODE);
    expect(planPosts()).toEqual([{ items: PATHS, moviePattern: DEFAULT_MOVIE, episodePattern: DEFAULT_EPISODE }]);

    act(() => root.unmount());
    root = createRoot(host);
    fetchMock.mockClear();
    localStorage.setItem("rename-patterns", JSON.stringify({ movie: "{year}", episode: "{title}" }));
    await open();
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!.value).toBe("{year}");
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Series episodes"]')!.value).toBe("{title}");
    expect(planPosts()).toEqual([{ items: PATHS, moviePattern: "{year}", episodePattern: "{title}" }]);
  });

  it("inserts a field token at the caret", async () => {
    await open();
    const movie = host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!;
    movie.focus();
    movie.setSelectionRange(7, 7);
    const season = [...host.querySelectorAll(".rename-pattern")[0]!.querySelectorAll("button")]
      .find((button) => button.textContent === "Season")!;
    await act(async () => { season.click(); });
    expect(movie.value).toBe("{title}{season} ({year})");
    expect(document.activeElement).toBe(movie);
    expect(movie.selectionStart).toBe(7 + "{season}".length);
  });

  it("debounces edits and ignores an older answer that arrives last", async () => {
    vi.useFakeTimers();
    let releaseOpen!: (value: Response) => void;
    const openGate = new Promise<Response>((resolve) => { releaseOpen = resolve; });
    let calls = 0;
    await open({
      fetchImpl: (url) => {
        if (!url.includes("/api/library/rename-plan")) return undefined;
        calls += 1;
        if (calls === 1) return openGate;
        return json({ rows: [row({ key: "fresh", from: "fresh.mkv", status: "rename", to: "Fresh" })] });
      },
    });
    expect(planPosts()).toHaveLength(1);

    const movie = host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!;
    await fill(movie, "{title}");
    await fill(movie, "{title} (");
    await fill(movie, "{title} ({year}");
    expect(planPosts()).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await flush();
    expect(planPosts()).toHaveLength(2);
    expect(host.textContent).toContain("fresh.mkv");
    expect(host.textContent).toContain("Fresh");

    await act(async () => {
      releaseOpen(json({ rows: [row({ key: "stale", from: "stale.mkv", status: "rename", to: "Stale" })] }));
    });
    await flush();
    expect(host.textContent).toContain("fresh.mkv");
    expect(host.textContent).not.toContain("stale.mkv");
  });

  it("keeps Apply off while a new preview is pending, even if the old one answers meanwhile", async () => {
    vi.useFakeTimers();
    let releaseOpen!: (value: Response) => void;
    const openGate = new Promise<Response>((resolve) => { releaseOpen = resolve; });
    let calls = 0;
    const { onStart } = await open({
      fetchImpl: (url) => {
        if (!url.includes("/api/library/rename-plan")) return undefined;
        calls += 1;
        if (calls === 1) return openGate;
        return new Promise<Response>(() => undefined);
      },
    });
    const movie = host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!;
    await fill(movie, "{title} [{year}]");
    // The answer for the old pattern lands inside the 400 ms wait.
    await act(async () => { releaseOpen(json({ rows: [row({ key: "old", from: "old.mkv", status: "rename", to: "Old (2000).mkv" })] })); });
    await flush();
    const apply = [...host.querySelectorAll<HTMLButtonElement>(".dialog-foot button")].find((button) => button.className.includes("primary"))!;
    expect(apply.disabled).toBe(true);
    await act(async () => { apply.click(); });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("renders every status, folder and sidecar tags, chips and sort order", async () => {
    await open({
      rows: [
        row({ key: "same", from: "s-same", status: "same" }),
        row({ key: "busy", from: "a-busy", status: "busy" }),
        row({ key: "file", from: "z-file", status: "rename", to: "Z File" }),
        row({ key: "unidentified", from: "g-unidentified", status: "unidentified", kind: "unknown" }),
        row({ key: "folder", from: "m-folder", status: "rename", to: "Folder Name", isFile: false, sidecars: 2, kind: "episode" }),
        row({ key: "missing", from: "f-missing", status: "missing", missing: ["title", "year"] }),
        row({ key: "invalid", from: "e-invalid", status: "invalid" }),
        row({ key: "collision", from: "c-collision", status: "collision" }),
        row({ key: "duplicate", from: "d-duplicate", status: "duplicate" }),
        row({ key: "chain", from: "b-chain", status: "chain" }),
      ],
    });

    expect(host.textContent).toContain("Renamed: 2");
    expect(host.textContent).toContain("Unchanged: 1");
    expect(host.textContent).toContain("Cannot rename: 7");

    expect([...host.querySelectorAll(".rename-table tbody tr td:first-child")].map((cell) => cell.textContent)).toEqual([
      "m-folder", "z-file", "a-busy", "b-chain", "c-collision", "d-duplicate", "e-invalid", "f-missing", "g-unidentified", "s-same",
    ]);

    const folderRow = [...host.querySelectorAll(".rename-table tbody tr")].find((tr) => tr.textContent?.includes("m-folder"))!;
    expect(folderRow.textContent).toContain("Folder Name");
    expect(folderRow.textContent).toContain("folder");
    expect(folderRow.textContent).toContain("+ 2 subtitles");

    const fileRow = [...host.querySelectorAll(".rename-table tbody tr")].find((tr) => tr.textContent?.includes("z-file"))!;
    expect(fileRow.textContent).toContain("Z File");
    expect(fileRow.textContent).not.toContain("folder");

    expect(host.textContent).toContain("unchanged");
    expect(host.textContent).toContain("not identified");
    expect(host.textContent).toContain("missing: title, year");
    expect(host.textContent).toContain("this name cannot be used on disk");
    expect(host.textContent).toContain("a file or folder of that name already exists");
    expect(host.textContent).toContain("another selected item would get the same name");
    expect(host.textContent).toContain("another selected item has this name now; rename that one separately first");
    expect(host.textContent).toContain("busy with another library operation");
  });

  it("shows the invalid-pattern text and disables Apply", async () => {
    await open({
      fetchImpl: (url) => url.includes("/api/library/rename-plan")
        ? json({ error: "bad pattern", messageKey: "err.renamePatternInvalid" }, 400)
        : undefined,
    });
    expect(host.textContent).toContain("The pattern names an unknown field or leaves a brace open.");
    expect(host.querySelector(".rename-table")).toBeNull();
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent?.startsWith("Rename (")) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
  });

  it("applies rename rows in chunks of 500 and skips blocked and same rows", async () => {
    const renaming = Array.from({ length: 1201 }, (_, index) => row({
      key: `k${index}`, from: `old${index}`, status: "rename", to: `new${index}`,
    }));
    const extra = [
      row({ key: "same-1", from: "same-a", status: "same" }),
      row({ key: "busy-1", from: "busy-a", status: "busy" }),
    ];
    const { onStart, onClose } = await open({ rows: [...extra, ...renaming] });
    const apply = [...host.querySelectorAll("button")].find((button) => button.textContent === "Rename (1201)") as HTMLButtonElement;
    expect(apply.disabled).toBe(false);
    await act(async () => { apply.click(); });
    expect(onStart).toHaveBeenCalledTimes(1);
    const operations = onStart.mock.calls[0]![0] as LibraryOp[];
    expect(operations).toHaveLength(3);
    expect(operations.map((operation) => {
      if (operation.op !== "rename") throw new Error("expected rename");
      return { items: operation.items.length, names: Object.keys(operation.names).length };
    })).toEqual([
      { items: 500, names: 500 },
      { items: 500, names: 500 },
      { items: 201, names: 201 },
    ]);
    expect(operations[0]).toMatchObject({ op: "rename" });
    if (operations[0]!.op !== "rename" || operations[2]!.op !== "rename") throw new Error("expected rename");
    expect(operations[0].items[0]).toBe("k0");
    expect(operations[0].names.k0).toBe("new0");
    expect(operations[0].items).not.toContain("same-1");
    expect(operations[0].items).not.toContain("busy-1");
    expect(operations[2].items).toHaveLength(201);
    expect(operations[2].items.at(-1)).toBe("k1200");
    expect(operations[2].names.k1200).toBe("new1200");
    expect(onClose).toHaveBeenCalled();
  });

  it("opens with the defaults when localStorage throws", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      await open();
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!.value).toBe(DEFAULT_MOVIE);
      expect(host.querySelector<HTMLInputElement>('input[aria-label="Series episodes"]')!.value).toBe(DEFAULT_EPISODE);
      expect(planPosts()[0]).toMatchObject({ moviePattern: DEFAULT_MOVIE, episodePattern: DEFAULT_EPISODE, items: PATHS });
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("drops the old preview when the preview for a new pattern fails, so Apply cannot use it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    await open({
      fetchImpl: (url) => {
        if (!url.includes("/api/library/rename-plan")) return undefined;
        calls += 1;
        return calls === 1
          ? json({ rows: [row({ key: "a", from: "a.mkv", to: "A (2000).mkv", status: "rename" })] })
          : json({ error: "server away" }, 500);
      },
    });
    const apply = () => [...host.querySelectorAll<HTMLButtonElement>(".dialog-foot button")].find((button) => button.className.includes("primary"))!;
    expect(apply().disabled).toBe(false);
    await fill(host.querySelector<HTMLInputElement>('input[aria-label="Films"]')!, "{title}");
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await flush();
    expect(host.textContent).toContain("server away");
    expect(apply().disabled).toBe(true);
    expect(host.querySelector(".rename-table")).toBeNull();
  });
});
