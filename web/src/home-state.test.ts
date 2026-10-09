import { describe, expect, it } from "vitest";
import { HOME_ROWS, emptyHomeRows, homeAllRowsEmpty, homeReducer, homeRowsFor } from "./home-state";
import type { HomeCard, HomeResponse, HomeRow, HomeRowId } from "../../server/src/home";

const card = (key: string): HomeCard => ({
  kind: "resume-file", key, title: key, path: `lib_00000000/${key}.mkv`,
  progress: { position: 1, duration: 10 }, updatedAt: "2026-01-01T00:00:00.000Z", forgetKeys: [key],
});
const ok = (items: HomeCard[], over: Partial<HomeRow> = {}): HomeRow => ({ status: "ok", items, hasMore: false, ...over });
const response = (rows: HomeResponse["rows"]): HomeResponse => ({ generatedAt: "2026-01-01T00:00:00.000Z", rows });
const answer = (over: Partial<Record<HomeRowId, HomeRow>> = {}): HomeResponse => response({
  resume: ok([]), episodes: ok([]), completed: ok([]), recent: ok([]), tonight: ok([]), favorites: ok([]), confirm: ok([]), ...over,
});
const ALL = HOME_ROWS;

describe("HOME_ROWS", () => {
  it("knows every server row, in page order, including the four this task adds", () => {
    expect([...HOME_ROWS]).toEqual(["resume", "favorites", "tonight", "episodes", "completed", "recent", "confirm"]);
  });

  it("asks an administrator for all eight rows and an ordinary account for the seven it may see", () => {
    expect([...homeRowsFor(true)]).toEqual([...HOME_ROWS]);
    expect([...homeRowsFor(false)]).toEqual(["resume", "favorites", "tonight", "episodes", "completed", "recent"]);
    expect(homeRowsFor(false)).not.toContain("confirm");
  });
});

describe("homeReducer", () => {
  it("fills each row from the first load", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    expect(state.resume?.status).toBe("loading");
    expect(state.episodes?.items).toEqual([]);
    expect(state.recent?.status).toBe("loading");

    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: answer({ resume: ok([card("a")]), favorites: ok([card("b")]) }) });
    expect(state.resume).toMatchObject({ status: "ok" });
    expect(state.resume?.items.map((item) => item.key)).toEqual(["a"]);
    expect(state.episodes?.status).toBe("ok");
    expect(state.favorites?.items.map((item) => item.key)).toEqual(["b"]);
  });

  it("keeps a row's cards while a later request is in flight", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ["resume"], request: 1 });
    state = homeReducer(state, { type: "answer", rows: ["resume"], request: 1, response: response({ resume: ok([card("a")]) }) });
    state = homeReducer(state, { type: "begin", rows: ["resume"], request: 2 });
    expect(state.resume?.status).toBe("loading");
    expect(state.resume?.items.map((item) => item.key)).toEqual(["a"]);
  });

  it("ignores an answer whose request a newer one superseded", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ["resume"], request: 1 });
    state = homeReducer(state, { type: "begin", rows: ["resume"], request: 2 });
    state = homeReducer(state, { type: "answer", rows: ["resume"], request: 1, response: response({ resume: ok([card("stale")]) }) });
    expect(state.resume?.status).toBe("loading");
    expect(state.resume?.items).toEqual([]);
  });

  it("does not clear the other rows when one row fails", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: answer({
      resume: ok([card("a")]),
      completed: { status: "error", error: { error: "boom" }, items: [], hasMore: false },
      favorites: ok([card("b")]),
    }) });
    expect(state.resume?.items.map((item) => item.key)).toEqual(["a"]);
    expect(state.favorites?.items.map((item) => item.key)).toEqual(["b"]);
    expect(state.completed).toMatchObject({ status: "error", items: [] });
  });

  it("retries a single row without touching the others", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "fail", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "begin", rows: ["completed"], request: 2 });
    expect(state.completed?.status).toBe("loading");
    expect(state.resume?.status).toBe("error");
    expect(state.favorites?.status).toBe("error");
    state = homeReducer(state, { type: "answer", rows: ["completed"], request: 2, response: response({ completed: ok([card("c")]) }) });
    expect(state.completed?.status).toBe("ok");
    expect(state.resume?.status).toBe("error");
  });

  it("carries a partial row through", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ["resume"], request: 1 });
    state = homeReducer(state, { type: "answer", rows: ["resume"], request: 1, response: response({ resume: ok([card("a")], { partial: true }) }) });
    expect(state.resume).toMatchObject({ status: "ok", partial: true });
  });

  it("keeps the exact count a row reports", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ["confirm"], request: 1 });
    state = homeReducer(state, { type: "answer", rows: ["confirm"], request: 1, response: response({ confirm: ok([card("a")], { total: 7 }) }) });
    expect(state.confirm).toMatchObject({ status: "ok", total: 7 });
  });

  it("touches only the Tonight row when that row is re-requested with a shuffle seed", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: answer({ resume: ok([card("b")]), tonight: ok([card("a")]) }) });

    state = homeReducer(state, { type: "begin", rows: ["tonight"], request: 2 });
    expect(state.tonight?.status).toBe("loading");
    expect(state.tonight?.items.map((item) => item.key)).toEqual(["a"]);
    expect(state.resume?.status).toBe("ok");
    expect(state.episodes?.status).toBe("ok");
    expect(state.confirm?.status).toBe("ok");

    state = homeReducer(state, { type: "answer", rows: ["tonight"], request: 2, response: response({ tonight: ok([card("c")]) }) });
    expect(state.tonight?.items.map((item) => item.key)).toEqual(["c"]);
    expect(state.resume?.items.map((item) => item.key)).toEqual(["b"]);
  });

  it("discards everything on reset", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: answer({ resume: ok([card("a")]) }) });
    expect(homeReducer(state, { type: "reset" })).toEqual({});
  });
});

describe("homeAllRowsEmpty", () => {
  const loaded = (rows: readonly HomeRowId[]) => homeReducer(
    homeReducer(emptyHomeRows(), { type: "begin", rows, request: 1 }),
    { type: "answer", rows, request: 1, response: answer() },
  );

  it("is true for an administrator only when all eight answered and every one is empty", () => {
    expect(homeAllRowsEmpty(loaded(homeRowsFor(true)), homeRowsFor(true))).toBe(true);
  });

  it("does not wait for the administrator-only row an ordinary account never asks for", () => {
    const state = loaded(homeRowsFor(false));
    expect(state.confirm).toBeUndefined();
    expect(homeAllRowsEmpty(state, homeRowsFor(false))).toBe(true);
    expect(homeAllRowsEmpty(state, homeRowsFor(true))).toBe(false);
  });

  it("is false while an asked row is loading, failed, or holds a card", () => {
    const asked = homeRowsFor(false);
    const answered = loaded(asked);
    expect(homeAllRowsEmpty(homeReducer(answered, { type: "begin", rows: ["favorites"], request: 2 }), asked), "loading").toBe(false);
    expect(homeAllRowsEmpty(homeReducer(answered, { type: "fail", rows: ["resume"], request: 1 }), asked), "failed").toBe(false);
    const held = homeReducer(answered, { type: "answer", rows: ["tonight"], request: 1, response: answer({ tonight: ok([card("a")]) }) });
    expect(homeAllRowsEmpty(held, asked), "a card").toBe(false);
    expect(homeAllRowsEmpty(emptyHomeRows(), asked), "nothing answered yet").toBe(false);
  });
});
