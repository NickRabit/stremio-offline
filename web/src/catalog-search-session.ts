import { api, ApiError } from "./api";
import type {
  CatalogSearchPollResult,
  CatalogSearchRequest,
  CatalogSearchSnapshot,
} from "./types";

const POLL_PARTIAL_MS = 250;

export interface CatalogSearchClient {
  start(body: CatalogSearchRequest, signal?: AbortSignal): Promise<{ id: string; snapshot: CatalogSearchSnapshot }>;
  poll(id: string, revision: number, signal?: AbortSignal): Promise<CatalogSearchPollResult>;
  page(id: string): Promise<{ revision: number }>;
  delete(id: string): void;
}

export interface CatalogSearchCursor {
  id: string | null;
  revision: number;
}

export class CatalogSearchStartNotFound extends Error {
  constructor(readonly cause: unknown) {
    super("The catalogue search session route is not available.");
    this.name = "CatalogSearchStartNotFound";
  }
}

export const catalogSearchSession: CatalogSearchClient = {
  start: (body, signal) => api.startCatalogSearch(body, signal),
  poll: (id, revision, signal) => api.pollCatalogSearch(id, revision, signal),
  page: (id) => api.pageCatalogSearch(id),
  delete: (id) => api.deleteCatalogSearch(id),
};

export function newCatalogSearchSlot(): string {
  const uuid = globalThis.crypto?.randomUUID?.().replaceAll("-", "");
  if (uuid) return uuid;
  const bytes = new Uint8Array(18);
  globalThis.crypto?.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

const pause = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });

export async function runCatalogSearch(options: {
  reset: boolean;
  request: CatalogSearchRequest;
  cursor: CatalogSearchCursor;
  onSnapshot(snapshot: CatalogSearchSnapshot): void;
  onFirstSnapshot?(snapshot: CatalogSearchSnapshot): void;
  signal?: AbortSignal;
  client?: CatalogSearchClient;
}): Promise<void> {
  const client = options.client ?? catalogSearchSession;
  let state: CatalogSearchSnapshot["state"];
  // A session that ended meanwhile -- the viewer left the Catalog, or it expired while idle -- is
  // started again for the same query rather than failing the next page.
  let fresh = options.reset || options.cursor.id === null;
  let paged: { revision: number } | undefined;
  if (!fresh) {
    try {
      paged = await client.page(options.cursor.id!);
    } catch (error) {
      if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 410)) throw error;
      options.cursor.id = null;
      fresh = true;
    }
  }
  if (fresh) {
    let started: { id: string; snapshot: CatalogSearchSnapshot };
    try {
      started = await client.start(options.request, options.signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new CatalogSearchStartNotFound(error);
      }
      throw error;
    }
    options.cursor.id = started.id;
    options.cursor.revision = started.snapshot.revision;
    state = started.snapshot.state;
    options.onSnapshot(started.snapshot);
    if (options.reset) options.onFirstSnapshot?.(started.snapshot);
  } else {
    const previousRevision = options.cursor.revision;
    options.cursor.revision = paged!.revision;
    state = paged!.revision > previousRevision ? "partial" : "complete";
  }

  while (state !== "complete") {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const id = options.cursor.id;
    if (id === null) throw new Error("No catalogue search session is open.");
    const answer = await client.poll(id, options.cursor.revision, options.signal);
    if (answer.changed) {
      if (answer.snapshot === undefined) throw new Error("The catalogue search answer carried no snapshot.");
      options.cursor.revision = answer.snapshot.revision;
      state = answer.snapshot.state;
      options.onSnapshot(answer.snapshot);
      continue;
    }
    options.cursor.revision = answer.revision;
    if (state === "partial") await pause(POLL_PARTIAL_MS, options.signal);
    else break;
  }
}

export const catalogSearchHasMore = (
  snapshot: CatalogSearchSnapshot,
  reset: boolean,
  gained: boolean,
): boolean => snapshot.hasMore && !(snapshot.state === "complete" && !reset && !gained);
