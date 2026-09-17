import assert from "node:assert/strict";
import { test } from "node:test";
import { groupResumeRows, type ResumeRow } from "./resume-group.js";

const row = (path: string, modified: string, seriesKey?: string): ResumeRow =>
  ({ path, modified, ...(seriesKey ? { seriesKey } : {}) });
const paths = (rows: ResumeRow[]) => rows.map((item) => item.path);

test("two episodes of one show collapse to the newest", () => {
  const older = row("lib_ab12cd34/Father Ted/S01/01.mkv", "2026-01-01T10:00:00.000Z", "lib_ab12cd34/Father Ted");
  const newer = row("lib_ab12cd34/Father Ted/S01/02.mkv", "2026-01-02T10:00:00.000Z", "lib_ab12cd34/Father Ted");
  assert.deepEqual(paths(groupResumeRows([older, newer])), [newer.path]);
  assert.deepEqual(paths(groupResumeRows([newer, older])), [newer.path], "the winner keeps its own place in the input");
});

test("episodes in two season folders of one show still collapse", () => {
  const rows = [
    row("lib_ab12cd34/Father Ted/S01/01.mkv", "2026-01-02T10:00:00.000Z", "lib_ab12cd34/Father Ted"),
    row("lib_ab12cd34/Father Ted/S02/01.mkv", "2026-01-03T10:00:00.000Z", "lib_ab12cd34/Father Ted"),
  ];
  assert.deepEqual(paths(groupResumeRows(rows)), [rows[1].path]);
});

test("two different shows both survive", () => {
  const rows = [
    row("lib_ab12cd34/Father Ted/S01/01.mkv", "2026-01-02T10:00:00.000Z", "lib_ab12cd34/Father Ted"),
    row("lib_ab12cd34/Black Books/S01/02.mkv", "2026-01-01T10:00:00.000Z", "lib_ab12cd34/Black Books"),
  ];
  assert.deepEqual(paths(groupResumeRows(rows)), paths(rows));
});

test("a movie and an unmatched file pass through untouched", () => {
  const rows = [
    row("lib_ab12cd34/Practical Magic/Practical Magic.mkv", "2026-01-01T10:00:00.000Z"),
    row("lib_ab12cd34/downloads/whatever.mp4", "2026-01-02T10:00:00.000Z"),
  ];
  assert.deepEqual(groupResumeRows(rows), rows);
});

test("rows without a binding are never grouped, not even inside one folder", () => {
  const rows = [
    row("lib_ab12cd34/downloads/one.mp4", "2026-01-01T10:00:00.000Z"),
    row("lib_ab12cd34/downloads/two.mp4", "2026-01-02T10:00:00.000Z"),
  ];
  assert.deepEqual(paths(groupResumeRows(rows)), paths(rows));
});
