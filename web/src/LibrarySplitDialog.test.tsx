import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LibrarySplitDialog } from "./LibrarySplitDialog";
import { folderNameError, joinLibraryRoot } from "./library-split";
import { t, setLocale } from "./i18n";
import type { LibraryOpsState, LibraryView, SplitPlan, SplitPlanItem } from "./types";

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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const parent = (over: Partial<LibraryView> = {}): LibraryView => ({
  id: "lib_mix", name: "Downloads", type: "mixed", root: "/downloads",
  enabled: true, order: 0, addedAt: "2026-09-01T00:00:00.000Z", writeArtwork: true, autoScanMetadata: true,
  unreachable: false, readOnly: false, writable: true, defaultMovie: false, defaultSeries: false,
  titles: 4, files: 8, bytes: 1, ...over,
});

const seriesChild = {
  id: "lib_series", name: "Shows", type: "series" as const, relative: "Shows",
  enabled: true, unreachable: false, readOnly: false,
};

const planOf = (over: Partial<SplitPlan> = {}): SplitPlan => ({
  library: { id: "lib_mix", name: "Downloads", root: "/downloads", type: "mixed" },
  counts: { movies: 2, series: 1, unknown: 0 },
  children: [],
  folders: [],
  items: [],
  taken: [],
  ...over,
});

const item = (over: Partial<SplitPlanItem> & Pick<SplitPlanItem, "key" | "label" | "kind">): SplitPlanItem => ({
  relative: over.relative ?? over.label, basis: over.basis ?? "identified", ...over,
});

const job = (over: Partial<LibraryOpsState> = {}): LibraryOpsState => ({
  id: "job1", op: "move", status: "running", total: 1, done: 0, failed: 0, bytes: 0, bytesTotal: 0,
  startedAt: "2026-09-01T00:00:00.000Z", results: [], ...over,
});

const createdLibrary = (id: string, name: string): LibraryView => parent({ id, name, type: "movie", root: `/downloads/${name}` });

async function flush(times = 1) {
  for (let i = 0; i < times; i++) await act(async () => { await Promise.resolve(); });
}

async function flushUntil(predicate: () => boolean, times = 50) {
  for (let i = 0; i < times; i++) {
    if (predicate()) return;
    await flush();
  }
}

const click = async (text: string) => {
  const button = [...host.querySelectorAll("button")].find((candidate) => candidate.textContent?.trim() === text);
  expect(button, `"${text}" is on screen`).toBeTruthy();
  await act(async () => { button!.click(); await Promise.resolve(); });
};

const fill = async (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
};

const folderInputs = () => [...host.querySelectorAll<HTMLInputElement>('input[aria-label="Folder name"]')];

const checkedOption = (heading: string) => {
  const fieldset = [...host.querySelectorAll("fieldset")].find((block) => block.querySelector("legend")?.textContent === heading);
  return fieldset?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.closest("label")?.textContent?.trim();
};

const rowOf = (label: string) =>
  [...host.querySelectorAll("tr")].find((row) => row.querySelector(".library-split-item span")?.textContent === label);

const mutating = () => fetchMock.mock.calls
  .filter(([, init]) => {
    const method = (init as RequestInit | undefined)?.method;
    return method && method !== "GET";
  })
  .map(([url, init]) => ({
    url: String(url),
    method: (init as RequestInit).method,
    body: JSON.parse(String((init as RequestInit).body ?? "null")),
  }));

const open = async (plan: SplitPlan, library: LibraryView = parent(), extra?: (url: string, init?: RequestInit) => Response | undefined) => {
  act(() => root.unmount());
  root = createRoot(host);
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const override = extra?.(String(url), init);
    if (override) return override;
    if (String(url).includes("/split-plan")) return json(plan);
    return json({});
  });
  fetchMock.mockClear();
  await act(async () => {
    root.render(<LibrarySplitDialog library={library} onClose={vi.fn()} onApplied={vi.fn()}/>);
  });
  await flushUntil(() => host.textContent?.includes(t("split.stepLibraries")) ?? false);
};

it("preselects an existing series library, never offers an existing folder as it is, else new folders", async () => {
  await open(planOf({
    children: [seriesChild],
    folders: [{ name: "Filmy", movies: 3, series: 0, unknown: 0 }],
  }));
  expect(checkedOption(t("split.seriesHeading"))).toBe(t("split.targetExisting", { name: "Shows" }));
  // A library laid over a folder of titles would take them without their records; they move instead.
  expect(checkedOption(t("split.moviesHeading"))).toBe(t("split.targetNew"));
  expect(host.textContent).not.toContain("as it is");

  await open(planOf({ folders: [{ name: "Misc", movies: 1, series: 1, unknown: 0 }] }));
  expect(checkedOption(t("split.moviesHeading"))).toBe(t("split.targetNew"));
  expect(checkedOption(t("split.seriesHeading"))).toBe(t("split.targetNew"));
  expect(folderInputs().map((input) => input.value)).toEqual([t("split.defaultMoviesName"), t("split.defaultSeriesName")]);
});

it("validates new folder names and refuses Next", async () => {
  await open(planOf({ folders: [{ name: "Filmy", movies: 1, series: 1, unknown: 0 }] }));
  await fill(folderInputs()[0]!, "filmy");
  expect(host.textContent).toContain(t("split.nameTaken"));
  await click(t("split.next"));
  expect(host.textContent).toContain(t("split.stepLibraries"));
  expect(host.textContent).not.toContain(t("split.colItem"));

  await fill(folderInputs()[0]!, "a/b");
  expect(host.textContent).toContain(t("split.nameInvalid"));
  await click(t("split.next"));
  expect(host.textContent).toContain(t("split.stepLibraries"));

  await fill(folderInputs()[0]!, "Twin");
  await fill(folderInputs()[1]!, "Twin");
  expect(host.textContent).toContain(t("split.sameTarget"));
  await click(t("split.next"));
  expect(host.textContent).not.toContain(t("split.colItem"));
});

it("defaults step 2 destinations, tags guessed and unidentified, leaves busy without a select and moves titles from a single-kind folder", async () => {
  await open(planOf({
    children: [seriesChild],
    folders: [{ name: "Filmy", movies: 3, series: 0, unknown: 0 }],
    items: [
      item({ key: "m1", label: "Alien", kind: "movie", basis: "identified" }),
      item({ key: "s1", label: "Lost", kind: "series", basis: "guessed" }),
      item({ key: "u1", label: "Mystery", kind: "unknown", basis: "none" }),
      item({ key: "b1", label: "Downloading", kind: "movie", basis: "identified", busy: "download" }),
      item({ key: "p1", label: "Inception", relative: "Filmy/Inception", kind: "movie", basis: "identified" }),
    ],
  }));
  await click(t("split.next"));
  expect(rowOf("Alien")?.querySelector("select")?.value).toBe("movie");
  expect(rowOf("Lost")?.querySelector("select")?.value).toBe("series");
  expect(rowOf("Lost")?.textContent).toContain(t("split.guessed"));
  expect(rowOf("Mystery")?.querySelector("select")?.value).toBe("leave");
  expect(rowOf("Mystery")?.textContent).toContain(t("split.unidentified"));
  expect(rowOf("Downloading")?.querySelector("select")).toBeNull();
  expect(rowOf("Downloading")?.textContent).toContain(t("split.busyDownload"));
  expect(rowOf("Inception")?.querySelector("select")?.value).toBe("movie");
});

it("creates a new films folder fresh with its grants in one request, then defaults, then moves", async () => {
  const library = parent({ visibleTo: ["usr_1"] });
  const plan = planOf({
    children: [seriesChild],
    items: [
      item({ key: "mov", label: "Movie", kind: "movie" }),
      item({ key: "ser", label: "Show", kind: "series" }),
    ],
  });
  const jobs: LibraryOpsState[] = [];
  await open(plan, library, (url, init) => {
    if (url === "/api/libraries" && init?.method === "POST") return json(createdLibrary("lib_created", "Films"), 201);
    if (String(url).startsWith("/api/libraries/") && init?.method === "PATCH") return json(library);
    if (url === "/api/library/ops" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { items: string[] };
      const id = `job_${jobs.length + 1}`;
      jobs.push(job({ id, status: "completed", total: body.items.length, done: body.items.length }));
      return json({ id });
    }
    if (url === "/api/library/ops") return json({ jobs });
    return undefined;
  });
  await click(t("split.next"));
  await click(t("split.next"));
  await click(t("split.start"));
  await flushUntil(() => mutating().some((call) => call.url === "/api/library/ops"));
  await flush(8);

  expect(mutating()).toEqual([
    { url: "/api/libraries", method: "POST", body: {
      name: "Films", type: "movie", root: "/downloads/Films", create: true, fresh: true, visibleTo: ["usr_1"],
      autoScanMetadata: true, writeArtwork: true,
    } },
    { url: "/api/libraries/lib_created", method: "PATCH", body: { defaultMovie: true } },
    { url: "/api/libraries/lib_series", method: "PATCH", body: { defaultSeries: true } },
    { url: "/api/library/ops", method: "POST", body: {
      op: "move", items: ["mov"], target: "lib_created", confirmTypeMismatch: true,
    } },
    { url: "/api/library/ops", method: "POST", body: {
      op: "move", items: ["ser"], target: "lib_series", confirmTypeMismatch: true,
    } },
  ]);
});

it("chunks 1201 movable items of one kind into three move requests", async () => {
  const items = Array.from({ length: 1201 }, (_, index) => item({
    key: `m${index}`, label: `Movie ${index}`, kind: "movie",
  }));
  const jobs: LibraryOpsState[] = [];
  await open(planOf({ children: [seriesChild], items, counts: { movies: 1201, series: 0, unknown: 0 } }), parent(), (url, init) => {
    if (url === "/api/libraries" && init?.method === "POST") return json(createdLibrary("lib_created", "Films"), 201);
    if (String(url).startsWith("/api/libraries/") && init?.method === "PATCH") return json(parent());
    if (url === "/api/library/ops" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { items: string[] };
      const id = `job_${jobs.length + 1}`;
      jobs.push(job({ id, status: "completed", total: body.items.length, done: body.items.length }));
      return json({ id });
    }
    if (url === "/api/library/ops") return json({ jobs });
    return undefined;
  });
  await click(t("split.next"));
  await click(t("split.next"));
  await click(t("split.start"));
  await flushUntil(() => mutating().filter((call) => call.url === "/api/library/ops").length >= 3, 80);
  const ops = mutating().filter((call) => call.url === "/api/library/ops");
  expect(ops.map((call) => (call.body as { items: string[] }).items.length)).toEqual([500, 500, 201]);
}, 20_000);

it("stops after a failing create, with no PATCH or ops request", async () => {
  await open(planOf({
    children: [seriesChild],
    items: [item({ key: "mov", label: "Movie", kind: "movie" })],
  }), parent(), (url, init) => {
    if (url === "/api/libraries" && init?.method === "POST") return json({ error: "disk full" }, 400);
    return undefined;
  });
  await click(t("split.next"));
  await click(t("split.next"));
  await click(t("split.start"));
  await flushUntil(() => host.textContent?.includes(t("split.retryHint")) ?? false);
  expect(mutating().filter((call) => call.method === "PATCH")).toEqual([]);
  expect(mutating().filter((call) => call.url === "/api/library/ops")).toEqual([]);
  expect(host.textContent).toContain(t("split.progressStepFailed", { reason: "disk full" }));
  expect(host.textContent).toContain(t("split.retryHint"));
});

it("watches a job through running to a failed item, then stops polling", async () => {
  const plan = planOf({
    children: [seriesChild],
    items: [item({ key: "m1", label: "Alien", kind: "movie" })],
  });
  let polls = 0;
  await open(plan, parent(), (url, init) => {
    if (url === "/api/libraries" && init?.method === "POST") return json(createdLibrary("lib_created", "Films"), 201);
    if (String(url).startsWith("/api/libraries/") && init?.method === "PATCH") return json(parent());
    if (url === "/api/library/ops" && init?.method === "POST") return json({ id: "job-move" });
    if (url === "/api/library/ops") {
      polls += 1;
      if (polls === 1) {
        return json({ jobs: [job({ id: "job-move", status: "running", done: 0, total: 1 })] });
      }
      return json({ jobs: [job({
        id: "job-move", status: "completed", done: 1, total: 1, failed: 1,
        results: [{ path: "m1", ok: false, error: "nope", errorKey: "err.restricted" }],
      })] });
    }
    return undefined;
  });
  await click(t("split.next"));
  await click(t("split.next"));
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await click(t("split.start"));
  await flushUntil(() => host.textContent?.includes(t("split.progressMoving", { name: "Films", done: 0, total: 1 })) ?? false);
  expect(host.textContent).toContain(t("split.progressMoving", { name: "Films", done: 0, total: 1 }));
  await act(() => { vi.advanceTimersByTime(1500); });
  await flushUntil(() => host.textContent?.includes(t("split.done")) ?? false);
  expect(host.textContent).toContain(t("split.progressMoved", { name: "Films", done: 1, total: 1 }));
  expect(host.textContent).toContain(t("split.progressFailedItem", {
    item: "Alien", reason: t("err.restricted"),
  }));
  expect(host.textContent).toContain(t("split.retryHint"));
  expect(host.textContent).toContain(t("split.done"));
  const opsGets = () => fetchMock.mock.calls.filter(([url, init]) =>
    String(url) === "/api/library/ops" && (init as RequestInit | undefined)?.method !== "POST");
  const afterDone = opsGets().length;
  await act(() => { vi.advanceTimersByTime(5000); });
  await flush(4);
  expect(opsGets().length).toBe(afterDone);
});

it("joins a library root with the folder name using the parent's separator", () => {
  expect(joinLibraryRoot("C:\\Media", "Films")).toBe("C:\\Media\\Films");
  expect(joinLibraryRoot("/downloads/", "Films")).toBe("/downloads/Films");
});

it("refuses a new folder name that a top-level title already uses", () => {
  const plan = planOf({ items: [item({ key: "lib_mix/Films", label: "Films", relative: "Films", kind: "movie" })] });
  expect(folderNameError("films", plan)).toBe("nameTaken");
  expect(folderNameError("Series", plan)).toBeUndefined();
});

it("refreshes the list behind it when a library is created after the dialog was closed", async () => {
  act(() => root.unmount());
  root = createRoot(host);
  let finishCreate: (response: Response) => void = () => undefined;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/split-plan")) return json(planOf({ items: [item({ key: "mov", label: "Movie", kind: "movie" })] }));
    if (url === "/api/libraries" && init?.method === "POST") return new Promise<Response>((resolve) => { finishCreate = resolve; });
    return json({});
  });
  const onApplied = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    root.render(<LibrarySplitDialog library={parent()} onClose={onClose} onApplied={onApplied}/>);
  });
  await flushUntil(() => host.textContent?.includes(t("split.stepLibraries")) ?? false);
  await click(t("split.next"));
  await click(t("split.next"));
  await click(t("split.start"));
  await click(t("common.close"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onApplied).not.toHaveBeenCalled();
  await act(async () => { finishCreate(json(createdLibrary("lib_late", "Films"), 201)); await Promise.resolve(); });
  await flush(3);
  expect(onApplied).toHaveBeenCalledTimes(1);
});

it("refuses a new folder name that any entry under the root already has", () => {
  expect(folderNameError("empty", planOf({ taken: ["Empty"] }))).toBe("nameTaken");
});

it("offers a retry and does not claim done when a move job was cancelled part-way", async () => {
  const plan = planOf({
    children: [seriesChild],
    items: Array.from({ length: 10 }, (_, index) => item({ key: `m${index}`, label: `Movie ${index}`, kind: "movie" })),
  });
  await open(plan, parent(), (url, init) => {
    if (url === "/api/libraries" && init?.method === "POST") return json(createdLibrary("lib_created", "Films"), 201);
    if (String(url).startsWith("/api/libraries/") && init?.method === "PATCH") return json(parent());
    if (url === "/api/library/ops" && init?.method === "POST") return json({ id: "job_cancel" });
    if (url === "/api/library/ops") return json({ jobs: [job({ id: "job_cancel", status: "cancelled", total: 10, done: 2 })] });
    return undefined;
  });
  await click(t("split.next"));
  await click(t("split.next"));
  await click(t("split.start"));
  await flushUntil(() => host.textContent?.includes(t("split.retryHint")) ?? false);
  expect(host.textContent).toContain(t("split.progressMoved", { name: "Films", done: 2, total: 10 }));
  expect(host.textContent).toContain(t("split.retryHint"));
  expect([...host.querySelectorAll("button")].some((button) => button.textContent === t("common.retry"))).toBe(true);
  expect(host.textContent).not.toContain(t("split.done"));
});
