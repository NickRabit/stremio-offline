import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { emptyHomeRows, homeReducer, homeRowsFor, isHomeCatalogRow, type HomeRows } from "./home-state";
import type { HomeRowId } from "../../server/src/home";
import type { Addon } from "./types";

/** A shelf the server could not fill before its deadline is still being fetched there; asking
 *  again shortly picks the answer up. */
const PARTIAL_RETRY_MS = 2500;
const PARTIAL_RETRIES = 3;

/** Home's media rows, wired to `GET /api/home`. Each call names its rows, so a retry touches
 *  only the row that failed; an answer only lands on the request still current for it. Addon
 *  shelves load once they come near the screen, in a request of their own, so a slow addon
 *  never holds up Continue watching. */
export function useHome({ active, account, admin, addons, playerOpen }: { active: boolean; account: string | null; admin: boolean; addons: Addon[]; playerOpen: boolean }) {
  const [rows, setRows] = useState<HomeRows>(emptyHomeRows);
  const request = useRef(0);
  const allRows = useMemo(() => homeRowsFor(admin, addons), [admin, addons]);
  /** Addon shelves that have come into view, kept across visits until the account changes. */
  const shown = useRef(new Set<HomeRowId>());
  const retries = useRef(new Map<HomeRowId, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const pending = useRef(new Set<HomeRowId>());
  /** Bumped on an account change, so a retry planned for the previous account is dropped. */
  const epoch = useRef(0);

  const later = useCallback((run: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.current.delete(timer); run(); }, ms);
    timers.current.add(timer);
  }, []);

  const refresh = useCallback((ids: readonly HomeRowId[], options?: { shuffle?: number }) => {
    if (!ids.length) return;
    const number = ++request.current;
    const rows = [...ids];
    const generation = epoch.current;
    setRows((current) => homeReducer(current, { type: "begin", rows, request: number }));
    api.home(rows, options).then(
      (response) => {
        setRows((current) => homeReducer(current, { type: "answer", rows, request: number, response }));
        if (generation !== epoch.current) return;
        const unfinished: HomeRowId[] = [];
        for (const row of rows) {
          if (!isHomeCatalogRow(row)) continue;
          if (!response.rows[row]?.partial) { retries.current.delete(row); continue; }
          const tried = retries.current.get(row) ?? 0;
          if (tried >= PARTIAL_RETRIES) continue;
          retries.current.set(row, tried + 1);
          unfinished.push(row);
        }
        if (unfinished.length) later(() => refresh(unfinished, options), PARTIAL_RETRY_MS);
      },
      () => setRows((current) => homeReducer(current, { type: "fail", rows, request: number })),
    );
  }, [later]);

  /** Shelves that came into view in the same moment go out as one request. */
  const reveal = useCallback((row: HomeRowId) => {
    if (shown.current.has(row)) return;
    shown.current.add(row);
    if (pending.current.size === 0) later(() => {
      const rows = [...pending.current];
      pending.current.clear();
      refresh(rows);
    }, 0);
    pending.current.add(row);
  }, [later, refresh]);

  const full = useCallback(() => {
    retries.current.clear();
    refresh(allRows.filter((row) => !isHomeCatalogRow(row)));
    refresh(allRows.filter((row) => isHomeCatalogRow(row) && shown.current.has(row)));
  }, [allRows, refresh]);

  // A sign-out or an account switch discards every row and any answer still on its way.
  useEffect(() => {
    request.current += 1;
    epoch.current += 1;
    shown.current.clear();
    pending.current.clear();
    retries.current.clear();
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    setRows(emptyHomeRows());
  }, [account]);

  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  // Opening Home, and every return to it while signed in.
  useEffect(() => { if (active) full(); }, [active, full]);

  // Closing the player may have moved a title along, but only while Home is on screen.
  const wasOpen = useRef(playerOpen);
  useEffect(() => {
    if (wasOpen.current && !playerOpen && active) full();
    wasOpen.current = playerOpen;
  }, [playerOpen, active, full]);

  return { rows, refresh, reveal };
}
