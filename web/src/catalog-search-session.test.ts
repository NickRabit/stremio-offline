import { describe, expect, it, vi } from "vitest";
import {
  CatalogSearchStartNotFound,
  catalogSearchHasMore,
  runCatalogSearch,
  type CatalogSearchClient,
} from "./catalog-search-session";
import { ApiError } from "./api";
import type { CatalogSearchPollResult, CatalogSearchRequest, CatalogSearchSnapshot, Meta } from "./types";

const item = (id: string, name = id): Meta => ({ id, type: "movie", name });

const snapshot = (
  revision: number,
  state: CatalogSearchSnapshot["state"],
  items: Meta[],
  hasMore = false,
): CatalogSearchSnapshot => ({
  revision,
  state,
  items,
  sources: 2,
  pending: state === "partial" ? 1 : 0,
  failed: 0,
  hasMore,
});

const request: CatalogSearchRequest = {
  query: "matrix",
  slotId: "slot_12345",
  generation: 1,
};

describe("catalogue search session", () => {
  it("publishes the first snapshot before the slow catalogues complete", async () => {
    let finish!: (value: Extract<CatalogSearchPollResult, { changed: true }>) => void;
    const client: CatalogSearchClient = {
      start: vi.fn(async () => ({ id: "cs_1", snapshot: snapshot(1, "partial", [item("tt1")]) })),
      poll: vi.fn(() => new Promise<Extract<CatalogSearchPollResult, { changed: true }>>((resolve) => { finish = resolve; })),
      page: vi.fn(async () => ({ revision: 2 })),
      delete: vi.fn(),
    };
    const seen: string[][] = [];

    const running = runCatalogSearch({
      reset: true,
      request,
      cursor: { id: null, revision: 0 },
      onSnapshot: (next) => seen.push(next.items.map((entry) => entry.id)),
      client,
    });
    await vi.waitFor(() => expect(seen).toEqual([["tt1"]]));
    expect(client.poll).toHaveBeenCalledWith("cs_1", 1, undefined);

    finish({ changed: true, snapshot: snapshot(2, "complete", [item("tt1"), item("tt2")]) });
    await running;
    expect(seen).toEqual([["tt1"], ["tt1", "tt2"]]);
  });

  it("starts the same search again when Load more finds the session gone", async () => {
    const client: CatalogSearchClient = {
      start: vi.fn(async () => ({ id: "cs_2", snapshot: snapshot(1, "complete", [item("tt1"), item("tt2")]) })),
      poll: vi.fn(),
      page: vi.fn(async () => { throw new ApiError("Gone", 410); }),
      delete: vi.fn(),
    };
    const onFirstSnapshot = vi.fn();
    const cursor = { id: "cs_old", revision: 4 };
    const seen: string[][] = [];
    await runCatalogSearch({ reset: false, request, cursor, onSnapshot: (next) => seen.push(next.items.map((entry) => entry.id)), onFirstSnapshot, client });
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(cursor.id).toBe("cs_2");
    expect(seen).toEqual([["tt1", "tt2"]]);
    expect(onFirstSnapshot).not.toHaveBeenCalled();

    cursor.id = null as unknown as string;
    await runCatalogSearch({ reset: false, request, cursor, onSnapshot: vi.fn(), client });
    expect(client.start).toHaveBeenCalledTimes(2);
  });

  it("reports an old server so the catalogue can use GET /api/search", async () => {
    const client: CatalogSearchClient = {
      start: vi.fn(async () => { throw new ApiError("Not found", 404); }),
      poll: vi.fn(),
      page: vi.fn(),
      delete: vi.fn(),
    };
    await expect(runCatalogSearch({
      reset: true,
      request,
      cursor: { id: null, revision: 0 },
      onSnapshot: vi.fn(),
      client,
    })).rejects.toBeInstanceOf(CatalogSearchStartNotFound);
  });

  it("keeps the gained-nothing stop and records history only once", async () => {
    const client: CatalogSearchClient = {
      start: vi.fn(async () => ({ id: "cs_1", snapshot: snapshot(1, "complete", [item("tt1")], true) })),
      poll: vi.fn(async () => ({
        changed: true,
        revision: 2,
        snapshot: snapshot(2, "complete", [item("tt1")], true),
      })),
      page: vi.fn(async () => ({ revision: 2 })),
      delete: vi.fn(),
    };
    const cursor = { id: null as string | null, revision: 0 };
    const before = new Set<string>();
    let gained = false;
    let history = 0;
    let hasMore = true;

    await runCatalogSearch({
      reset: true,
      request,
      cursor,
      client,
      onSnapshot: (next) => {
        for (const entry of next.items) {
          if (!before.has(`${entry.type}:${entry.id}`)) {
            gained = true;
            break;
          }
        }
        hasMore = catalogSearchHasMore(next, true, gained);
      },
      onFirstSnapshot: () => { history += 1; },
    });
    before.add("movie:tt1");
    gained = false;
    await runCatalogSearch({
      reset: false,
      request,
      cursor,
      client,
      onSnapshot: (next) => {
        for (const entry of next.items) {
          if (!before.has(`${entry.type}:${entry.id}`)) {
            gained = true;
            break;
          }
        }
        hasMore = catalogSearchHasMore(next, false, gained);
      },
    });

    expect(hasMore).toBe(false);
    expect(history).toBe(1);
    expect(client.page).toHaveBeenCalledWith("cs_1");
  });
});
