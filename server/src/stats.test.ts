import assert from "node:assert/strict";
import test from "node:test";
import { compact, registrableDomain, summarize, type TrafficEvent, type TrafficSource } from "./stats.js";

const GB = 1024 ** 3;
const now = new Date("2026-09-02T18:00:00");
const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();

const event = (hours: number, bytes: number, provider: string, addon = provider, source: TrafficSource = "download"): TrafficEvent =>
  ({ at: ago(hours), bytes, items: 1, source, provider, addonKey: addon, addonName: addon, title: `Film ${hours}`, kind: "movie" });

const sample: TrafficEvent[] = [
  event(0.2, 2 * GB, "cdn.jedna.cz"),
  event(10, 1 * GB, "cdn.dva.cz"),
  event(50, 3 * GB, "cdn.jedna.cz"),
  event(200, 4 * GB, "cdn.tri.cz"),
  event(1000, 5 * GB, "cdn.dva.cz"),
];

test("the windows are computed independently of the chosen period", () => {
  for (const hours of [1, 24, 720]) {
    const summary = summarize(sample, hours, now);
    assert.deepEqual(summary.hour, { bytes: 2 * GB, count: 1 }, `the hour window over a ${hours} h period`);
    assert.deepEqual(summary.day, { bytes: 3 * GB, count: 2 });
    assert.deepEqual(summary.week, { bytes: 6 * GB, count: 3 });
    assert.deepEqual(summary.month, { bytes: 10 * GB, count: 4 });
    assert.deepEqual(summary.total, { bytes: 15 * GB, count: 5 });
  }
});

test("an hour period is split into five-minute bars", () => {
  const summary = summarize(sample, 1, now);
  assert.equal(summary.step, "minute");
  assert.equal(summary.points.length, 12);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 2 * GB, "only the newest entry falls inside the hour");
  const gap = Date.parse(summary.points[1].at) - Date.parse(summary.points[0].at);
  assert.equal(gap, 5 * 60_000);
});

test("a day period is split into hours", () => {
  const summary = summarize(sample, 24, now);
  assert.equal(summary.step, "hour");
  assert.equal(summary.points.length, 24);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 3 * GB);
  assert.equal(Date.parse(summary.points[1].at) - Date.parse(summary.points[0].at), 3600_000);
});

test("a longer period goes by days and the series is continuous", () => {
  const summary = summarize(sample, 30 * 24, now);
  assert.equal(summary.step, "day");
  assert.equal(summary.points.length, 30);
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 10 * GB);
  for (let index = 1; index < summary.points.length; index += 1) {
    const gap = Date.parse(summary.points[index].at) - Date.parse(summary.points[index - 1].at);
    assert.ok(gap >= 23 * 3600_000 && gap <= 25 * 3600_000, `the gap between days should be one day, was ${gap} ms`);
  }
});

test("providers are grouped by domain, addons stay as recorded, both ordered from the largest", () => {
  const { providers, addons } = summarize(sample, 30 * 24, now);
  assert.deepEqual(providers.map((item) => item.key), ["jedna.cz", "tri.cz", "dva.cz"]);
  assert.deepEqual(providers[0], { key: "jedna.cz", label: "jedna.cz", bytes: 5 * GB, count: 2 });
  assert.deepEqual(addons.map((item) => item.key), ["cdn.jedna.cz", "cdn.tri.cz", "cdn.dva.cz"]);
  assert.deepEqual(addons.map((item) => item.bytes), [5 * GB, 4 * GB, 1 * GB]);
});

test("a host is grouped under its registrable domain", () => {
  const cases: Array<[string, string]> = [
    ["den2-4.download.real-debrid.com", "real-debrid.com"],
    ["cdn.freevideo.cz", "freevideo.cz"],
    ["torrentio.strem.fun", "strem.fun"],
    ["tpb-adult-addon.click", "tpb-adult-addon.click"],
    ["cdn.jedna.co.uk", "jedna.co.uk"],
    ["cdn.jedna.cz.", "jedna.cz"],
    ["localhost", "localhost"],
    ["knihovna", "knihovna"],
    ["unknown", "unknown"],
    ["192.168.0.10", "192.168.0.10"],
    ["2a00:1450:4001:80d::200e", "2a00:1450:4001:80d::200e"],
    ["[2a00:1450:4001:80d::200e]", "[2a00:1450:4001:80d::200e]"],
    ["", ""],
  ];
  for (const [host, expected] of cases) {
    assert.equal(registrableDomain(host), expected, `registrableDomain(${JSON.stringify(host)})`);
  }
});

test("two hosts of one domain share a row and keep their own bytes and items", () => {
  const events: TrafficEvent[] = [
    event(1, 3 * GB, "den2-4.download.real-debrid.com"),
    event(2, 1 * GB, "131-4.download.real-debrid.com"),
  ];
  const [provider] = summarize(events, 24, now).providers;
  assert.deepEqual(provider, {
    key: "real-debrid.com", label: "real-debrid.com", bytes: 4 * GB, count: 2,
    hosts: [
      { key: "den2-4.download.real-debrid.com", label: "den2-4.download.real-debrid.com", bytes: 3 * GB, items: 1 },
      { key: "131-4.download.real-debrid.com", label: "131-4.download.real-debrid.com", bytes: 1 * GB, items: 1 },
    ],
  });
});

test("a domain behind a single host carries no host list", () => {
  const [provider] = summarize([event(1, GB, "cdn.jedna.cz")], 24, now).providers;
  assert.equal(provider.hosts, undefined, "the row is the host itself, so there is nothing to open");
});

test("the addon and source breakdowns are untouched by the grouping", () => {
  const events = [
    event(1, 2 * GB, "den2-4.download.real-debrid.com", "Torrentio"),
    event(2, 3 * GB, "den2-4.download.real-debrid.com", "Torrentio", "catalog"),
    event(3, 1 * GB, "cdn.jedna.cz"),
  ];
  const summary = summarize(events, 24, now);
  assert.deepEqual(summary.providers.map((item) => item.key), ["real-debrid.com", "jedna.cz"]);
  assert.deepEqual(summary.addons, [
    { key: "Torrentio", label: "Torrentio", bytes: 5 * GB, count: 2 },
    { key: "cdn.jedna.cz", label: "cdn.jedna.cz", bytes: 1 * GB, count: 1 },
  ], "an addon keeps the name it was recorded under, host or not");
  assert.deepEqual(summary.sources.find((item) => item.key === "download"),
    { key: "download", label: "Downloads", bytes: 3 * GB, count: 2 });
});

test("every source has its own series in the same order as the overview", () => {
  const summary = summarize(sample, 30 * 24, now);
  assert.deepEqual(summary.byProvider.map((line) => line.key), summary.providers.map((item) => item.key));
  for (const line of summary.byProvider) {
    assert.equal(line.points.length, summary.points.length, "the series must have as many points as the chart");
    const total = summary.providers.find((item) => item.key === line.key)!.bytes;
    assert.equal(line.points.reduce((sum, value) => sum + value, 0), total, `the sum of series ${line.key}`);
  }
  const perPoint = summary.points.map((_, index) => summary.byProvider.reduce((sum, line) => sum + line.points[index], 0));
  assert.deepEqual(perPoint, summary.points.map((point) => point.bytes), "the series together add up to the whole chart");
});

test("an evening download belongs to the local day, not to the UTC one", () => {
  const late: TrafficEvent[] = [{ ...event(0, GB, "cdn.jedna.cz"), at: "2026-09-02T23:30:00+02:00" }];
  const summary = summarize(late, 3 * 24, new Date("2026-09-02T23:45:00+02:00"));
  assert.equal(summary.points.at(-1)?.bytes, GB, "it belongs to 2 September even though UTC is already on the 3rd");
});

test("an empty record does not throw", () => {
  const summary = summarize([], 7 * 24, now);
  assert.deepEqual(summary.total, { bytes: 0, count: 0 });
  assert.equal(summary.points.length, 7);
  assert.deepEqual(summary.providers, []);
  assert.deepEqual(summary.byProvider, []);
  assert.equal(summary.since, undefined);
});

test("library playback is not external traffic", () => {
  const events = [...sample, event(0.3, 9 * GB, "knihovna", "knihovna", "library")];
  const summary = summarize(events, 30 * 24, now);
  assert.deepEqual(summary.hour, { bytes: 2 * GB, count: 1 }, "local playback does not raise the card");
  assert.equal(summary.points.reduce((sum, point) => sum + point.bytes, 0), 10 * GB, "ani sloupce");
  assert.ok(!summary.providers.some((item) => item.key === "knihovna"), "ani rozpad podle zdroje");
});

test("traffic kinds break down including the library and each has its own series", () => {
  const events = [
    event(0.3, 1 * GB, "cdn.jedna.cz"),
    event(0.4, 2 * GB, "cdn.dva.cz", "cdn.dva.cz", "catalog"),
    event(0.5, 4 * GB, "knihovna", "knihovna", "library"),
  ];
  const summary = summarize(events, 24, now);
  assert.deepEqual(summary.sources.map((item) => item.key), ["library", "catalog", "download"]);
  assert.deepEqual(summary.bySource.map((line) => line.key), summary.sources.map((item) => item.key));
  const library = summary.bySource.find((line) => line.key === "library")!;
  assert.equal(library.points.reduce((sum, value) => sum + value, 0), 4 * GB);
  assert.deepEqual(summary.total, { bytes: 3 * GB, count: 2 }, "the total is external traffic only");
});

test("running increments count as one item", () => {
  const chunks: TrafficEvent[] = [
    { ...event(3, 1 * GB, "cdn.jedna.cz"), items: 0 },
    { ...event(2, 1 * GB, "cdn.jedna.cz"), items: 0 },
    { ...event(1, 0, "cdn.jedna.cz"), items: 1 },
  ];
  const summary = summarize(chunks, 24, now);
  assert.deepEqual(summary.day, { bytes: 2 * GB, count: 1 });
  const spread = summary.points.filter((point) => point.bytes).length;
  assert.equal(spread, 2, "the bytes belong to the hours they flowed in, not to a single bar");
});

test("older entries merge by the hour and the sums hold", () => {
  const old = new Date(now.getTime() - 50 * 3600_000);
  const at = (minutes: number) => new Date(old.getTime() + minutes * 60_000).toISOString();
  const events: TrafficEvent[] = [
    { ...event(50, 1 * GB, "cdn.jedna.cz"), at: at(1), items: 0 },
    { ...event(50, 2 * GB, "cdn.jedna.cz"), at: at(20), items: 0 },
    { ...event(50, 0, "cdn.jedna.cz"), at: at(40), items: 1 },
    { ...event(50, 1 * GB, "cdn.dva.cz"), at: at(70), items: 1 },
    event(2, 5 * GB, "cdn.jedna.cz"),
  ];
  const merged = compact(events, now.getTime() - 24 * 3600_000);
  assert.equal(merged.length, 3, "three entries from one hour and one source merge into one");
  assert.equal(merged.reduce((sum, item) => sum + item.bytes, 0), 9 * GB);
  assert.equal(merged.reduce((sum, item) => sum + item.items, 0), 3);
  assert.deepEqual(summarize(merged, 90 * 24, now).total, summarize(events, 90 * 24, now).total);
});
