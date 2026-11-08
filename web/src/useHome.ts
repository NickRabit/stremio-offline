import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { readHomeCache, writeHomeCache } from "./home-cache";
import { emptyHomeRows, homeReducer, homeRowsFor, isHomeCatalogRow, type HomeRows } from "./home-state";
import { isScrolling } from "./home-omit";
import type { HomeOrderEntry, HomeRowId } from "../../server/src/home";

/** A shelf the server could not fill before its deadline is still being fetched there; asking
 *  again shortly picks the answer up. */
const PARTIAL_RETRY_MS = 2500;
const PARTIAL_RETRIES = 3;
const HOME_CACHE_WRITE_MS = 500;

const shownCatalogueRows = (rows: HomeRows): Set<HomeRowId> => {
  const shown = new Set<HomeRowId>();
  for (const row of Object.keys(rows)) {
    if (isHomeCatalogRow(row as HomeRowId)) shown.add(row as HomeRowId);
  }
  return shown;
};

/** Home's media rows, wired to `GET /api/home`. Each call names its rows, so a retry touches
 *  only the row that failed; an answer only lands on the request still current for it. Addon
 *  shelves load once they come near the screen, in a request of their own, so a slow addon
 *  never holds up Continue watching. */
export function useHome({ active, account, admin, playerOpen }: { active: boolean; account: string | null; admin: boolean; playerOpen: boolean }) {
  const [initial] = useState(() => account === null ? null : readHomeCache(account));
  const [rows, setRows] = useState<HomeRows>(() => initial?.rows ?? emptyHomeRows());
  /** The shelves the server says this account has, in its own order. A personal layout can
   *  hide a built-in or add a feed the client's addon list does not know, so the answer -- not
   *  `homeRowsFor` -- is what the page draws once it arrives. */
  const [order, setOrder] = useState<HomeOrderEntry[]>(() => initial?.order ?? []);
  const [builtFor, setBuiltFor] = useState(account);
  const orderRef = useRef<HomeOrderEntry[]>(initial?.order ?? []);
  const request = useRef(0);
  const builtinRows = useMemo(() => homeRowsFor(admin), [admin]);
  /** Addon shelves that have come into view, kept across visits until the account changes. */
  const shown = useRef(shownCatalogueRows(initial?.rows ?? {}));
  const retries = useRef(new Map<HomeRowId, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const pending = useRef(new Set<HomeRowId>());
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Bumped on an account change, so a retry planned for the previous account is dropped. */
  const epoch = useRef(0);

  let appliedRows = rows;
  let appliedOrder = order;
  if (account !== builtFor) {
    const cached = account === null ? null : readHomeCache(account);
    appliedRows = cached?.rows ?? emptyHomeRows();
    appliedOrder = cached?.order ?? [];
    setRows(appliedRows);
    setOrder(appliedOrder);
    setBuiltFor(account);
  }

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
        setOrder(response.order);
        orderRef.current = response.order;
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
    if (builtinRows.includes("resume")) {
      refresh(["resume"]);
      refresh(builtinRows.filter((row) => row !== "resume"));
    } else {
      refresh(builtinRows);
    }
    refresh(orderRef.current.filter((entry) => isHomeCatalogRow(entry.id) && shown.current.has(entry.id)).map((entry) => entry.id));
  }, [builtinRows, refresh]);

  // A sign-out or an account switch discards every row and any answer still on its way.
  useEffect(() => {
    request.current += 1;
    epoch.current += 1;
    shown.current = shownCatalogueRows(rows);
    pending.current.clear();
    retries.current.clear();
    for (const timer of timers.current) clearTimeout(timer);
    timers.current.clear();
    orderRef.current = order;
  }, [account]);

  useEffect(() => () => { for (const timer of timers.current) clearTimeout(timer); }, []);

  useEffect(() => {
    if (cacheTimer.current) clearTimeout(cacheTimer.current);
    cacheTimer.current = undefined;
    if (account === null || !Object.values(rows).some((row) => row?.status === "ok")) return;
    const schedule = () => {
      cacheTimer.current = setTimeout(() => {
        if (isScrolling()) { schedule(); return; }
        cacheTimer.current = undefined;
        writeHomeCache(account, order, rows);
      }, HOME_CACHE_WRITE_MS);
    };
    schedule();
    return () => {
      if (!cacheTimer.current) return;
      clearTimeout(cacheTimer.current);
      cacheTimer.current = undefined;
    };
  }, [rows, order, account]);

  // Opening Home, and every return to it while signed in.
  useEffect(() => { if (active && account !== null) full(); }, [active, account, full]);

  // Closing the player may have moved a title along, but only while Home is on screen.
  const wasOpen = useRef(playerOpen);
  useEffect(() => {
    if (wasOpen.current && !playerOpen && active && account !== null) full();
    wasOpen.current = playerOpen;
  }, [playerOpen, active, account, full]);

  return { rows: appliedRows, order: appliedOrder, refresh, reveal };
}
