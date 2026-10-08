import { describe, expect, it } from "vitest";
import { emptyHomeRows, homeAllRowsEmpty, homeReducer } from "./home-state";
import type { HomeCard, HomeResponse, HomeRow } from "../../server/src/home";

const card = (key: string): HomeCard => ({
  kind: "resume-file", key, title: key, path: `lib_00000000/${key}.mkv`,
  progress: { position: 1, duration: 10 }, updatedAt: "2026-01-01T00:00:00.000Z", forgetKeys: [key],
});
const ok = (items: HomeCard[], over: Partial<HomeRow> = {}): HomeRow => ({ status: "ok", items, hasMore: false, ...over });
const response = (rows: HomeResponse["rows"]): HomeResponse => ({ generatedAt: "2026-01-01T00:00:00.000Z", rows });
const ALL = ["resume", "completed", "favorites"] as const;

describe("homeReducer", () => {
  it("fills each row from the first load", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    expect(state.resume?.status).toBe("loading");
    expect(state.completed?.items).toEqual([]);

    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: response({ resume: ok([card("a")]), completed: ok([]), favorites: ok([card("b")]) }) });
    expect(state.resume).toMatchObject({ status: "ok" });
    expect(state.resume?.items.map((item) => item.key)).toEqual(["a"]);
    expect(state.completed?.status).toBe("ok");
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
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: response({ resume: ok([card("a")]), completed: { status: "error", error: { error: "boom" }, items: [], hasMore: false }, favorites: ok([card("b")]) }) });
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

  it("discards everything on reset", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: response({ resume: ok([card("a")]) }) });
    expect(homeReducer(state, { type: "reset" })).toEqual({});
  });
});

describe("homeAllRowsEmpty", () => {
  it("is true only when every row answered and every one is empty", () => {
    let state = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    state = homeReducer(state, { type: "answer", rows: ALL, request: 1, response: response({ resume: ok([]), completed: ok([]), favorites: ok([]) }) });
    expect(homeAllRowsEmpty(state)).toBe(true);
  });

  it("is false while a row is loading, failed, or holds a card", () => {
    const answered = homeReducer(emptyHomeRows(), { type: "begin", rows: ALL, request: 1 });
    const loaded = homeReducer(answered, { type: "answer", rows: ALL, request: 1, response: response({ resume: ok([]), completed: ok([]), favorites: ok([]) }) });
    expect(homeAllRowsEmpty(homeReducer(loaded, { type: "begin", rows: ["favorites"], request: 2 })), "loading").toBe(false);
    expect(homeAllRowsEmpty(homeReducer(loaded, { type: "fail", rows: ["resume"], request: 1 })), "failed").toBe(false);
    const held = homeReducer(loaded, { type: "answer", rows: ["resume"], request: 1, response: response({ resume: ok([card("a")]) }) });
    expect(homeAllRowsEmpty(held), "a card").toBe(false);
    expect(homeAllRowsEmpty(emptyHomeRows()), "nothing answered yet").toBe(false);
  });
});
