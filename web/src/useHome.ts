import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { emptyHomeRows, homeReducer, homeRowsFor, type HomeRows } from "./home-state";
import type { HomeRowId } from "../../server/src/home";

/** Home's media rows, wired to `GET /api/home`. Each call names its rows, so a retry touches
 *  only the row that failed; an answer only lands on the request still current for it. */
export function useHome({ active, account, admin, playerOpen }: { active: boolean; account: string | null; admin: boolean; playerOpen: boolean }) {
  const [rows, setRows] = useState<HomeRows>(emptyHomeRows);
  const request = useRef(0);

  const refresh = useCallback((ids: readonly HomeRowId[], options?: { shuffle?: number }) => {
    if (!ids.length) return;
    const number = ++request.current;
    const rows = [...ids];
    setRows((current) => homeReducer(current, { type: "begin", rows, request: number }));
    api.home(rows, options).then(
      (response) => setRows((current) => homeReducer(current, { type: "answer", rows, request: number, response })),
      () => setRows((current) => homeReducer(current, { type: "fail", rows, request: number })),
    );
  }, []);

  const full = useCallback(() => refresh(homeRowsFor(admin)), [admin, refresh]);

  // A sign-out or an account switch discards every row and any answer still on its way.
  useEffect(() => { request.current += 1; setRows(emptyHomeRows()); }, [account]);

  // Opening Home, and every return to it while signed in.
  useEffect(() => { if (active) full(); }, [active, full]);

  // Closing the player may have moved a title along, but only while Home is on screen.
  const wasOpen = useRef(playerOpen);
  useEffect(() => {
    if (wasOpen.current && !playerOpen && active) full();
    wasOpen.current = playerOpen;
  }, [playerOpen, active, full]);

  return { rows, refresh };
}
