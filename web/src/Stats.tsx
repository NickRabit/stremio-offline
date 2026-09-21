import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import type { StatsActivityPage, ActiveStream, StatsBucket, StatsSeries, StatsSummary } from "./types";
import { localeTag, serverText, t, useI18n } from "./i18n";

const size = (value: number) => !value ? "0 B"
  : value >= 1e12 ? `${(value / 1e12).toFixed(2)} TB`
  : value >= 1e9 ? `${(value / 1e9).toFixed(1)} GB`
  : value >= 1e6 ? `${Math.round(value / 1e6)} MB`
  : `${Math.round(value / 1e3)} kB`;

const files = (count: number) => t("stats.items", { count });

/** How long the playback has been running, in the shape a player shows it. */
const elapsed = (from: string, now: number) => {
  const seconds = Math.max(0, Math.round((now - Date.parse(from)) / 1000));
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${pad(seconds % 60)}`;
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
};

/** Nothing arriving is the normal state of a played file: the player pulls a chunk, then
 * plays it for minutes without asking again -- a local file often arrives whole at once.
 * Silence only means trouble once the player stops reporting in too; it pings every thirty
 * seconds while it is open, so twice that is silence with nobody listening. */
const SILENT_SECONDS = 60;

/** Running playback is polled on its own; the summary behind it changes far more slowly. */
const LIVE_MS = 5_000;

/** Providers and addons are named by the outside world, the kinds of traffic by us. */
const seriesLabel = (kind: string, key: string, fallback: string) =>
  kind === "source" ? serverText(`stats.source.${key}`, fallback) : fallback;

const PERIODS = [
  { hours: 1, key: "stats.period.hour" },
  { hours: 24, key: "stats.period.day" },
  { hours: 168, key: "stats.period.week" },
  { hours: 720, key: "stats.period.month" },
  { hours: 2160, key: "stats.period.quarter" },
  { hours: 8760, key: "stats.period.year" },
] as const;

/** Colours for the picked series. The shades are checked against the panel's dark
 * ground: they hold one lightness band, keep their saturation and stay apart under
 * colour blindness, so neighbouring lines never merge. More than eight sources at
 * once cannot be told apart anyway. */
const COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

/** Five ticks on the Y axis, derived from the peak so the scale stays readable. */
const TICKS = [1, 0.75, 0.5, 0.25, 0];

/** Only a few labels fit on the X axis before they overlap. */
const xTicks = (count: number) => {
  const wanted = Math.min(6, count);
  if (wanted < 2) return [0];
  return Array.from({ length: wanted }, (_, index) => Math.round((index * (count - 1)) / (wanted - 1)));
};

const stamp = (at: string, step: StatsSummary["step"]) => {
  const date = new Date(at);
  if (step === "day") return date.toLocaleDateString(localeTag(), { day: "numeric", month: "numeric" });
  return date.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" });
};

function Card({ title, window }: { title: string; window: { bytes: number; count: number } }) {
  return <div className="stats-card">
    <small>{title}</small>
    <strong>{size(window.bytes)}</strong>
    <span>{files(window.count)}</span>
  </div>;
}

/** With nothing picked the total volume is drawn as bars; a pick gives every series
 * its own line. */
function Chart({ summary, lines }: { summary: StatsSummary; lines: Array<StatsSeries & { color: string; dashed?: boolean }> }) {
  const peak = Math.max(1, ...(lines.length ? lines.flatMap((line) => line.points) : summary.points.map((point) => point.bytes)));
  const width = 1000, height = 200;
  const stride = summary.points.length > 1 ? width / (summary.points.length - 1) : width;
  const marks = xTicks(summary.points.length);

  return <div className="stats-plot">
    <div className="stats-yaxis">
      {TICKS.map((tick) => <span key={tick} style={{ bottom: `${tick * 100}%` }}>{size(peak * tick)}</span>)}
    </div>

    <div className="stats-area">
      <div className="stats-grid" aria-hidden="true">{TICKS.map((tick) => <i key={tick} style={{ bottom: `${tick * 100}%` }}/>)}</div>
      {lines.length
        ? <>
            <svg className="stats-lines" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={t("stats.chosenTrend")}>
              {lines.map((line) => <polyline key={line.key} fill="none" stroke={line.color} strokeWidth={2} vectorEffect="non-scaling-stroke"
                strokeDasharray={line.dashed ? "6 4" : undefined} strokeLinejoin="round" strokeLinecap="round"
                points={line.points.map((value, index) => `${index * stride},${height - (value / peak) * (height - 6)}`).join(" ")}/>)}
            </svg>
            {/* Transparent columns over the chart carry the tooltip with every picked series. */}
            <div className="stats-hover">
              {summary.points.map((point, index) => <div key={point.at}
                title={`${stamp(point.at, summary.step)}\n${lines.map((line) => `${line.label}: ${size(line.points[index])}`).join("\n")}`}/>)}
            </div>
          </>
        : <div className="stats-chart" role="img" aria-label={t("stats.chartLabel", { peak: size(peak) })}>
            {summary.points.map((point) => <div key={point.at} className="stats-bar" title={`${stamp(point.at, summary.step)}: ${size(point.bytes)}, ${files(point.count)}`}>
              <span style={{ height: `${Math.max(point.bytes ? 2 : 0, (point.bytes / peak) * 100)}%` }}/>
            </div>)}
          </div>}
    </div>

    <div className="stats-xaxis">
      {marks.map((index, order) => <span key={index} style={{
        left: `${summary.points.length > 1 ? (index / (summary.points.length - 1)) * 100 : 0}%`,
        transform: order === 0 ? "none" : order === marks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
      }}>{summary.points[index] ? stamp(summary.points[index].at, summary.step) : ""}</span>)}
    </div>
  </div>;
}

/** How many rows of a long breakdown show before the rest are asked for. The provider
 *  list runs into dozens of rows, the addon list into dozens too. */
const VISIBLE_ROWS = 8;

/** One breakdown row: the row itself picks the series for the chart, while the count in
 *  its footnote opens the hosts behind it -- so opening a row cannot disturb a selection. */
function BreakdownRow({ kind, item, total, chosen, onToggle, colors }: {
  kind: string; item: StatsBucket; total: number;
  chosen: Set<string>; onToggle: (id: string) => void; colors: Map<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const id = `${kind}:${item.key}`;
  const color = colors.get(id);
  const share = total ? (item.bytes / total) * 100 : 0;
  return <li>
    <button className={`stats-pick${chosen.has(id) ? " chosen" : ""}`} onClick={() => onToggle(id)}
      aria-pressed={chosen.has(id)} title={chosen.has(id) ? t("stats.removeFromChart") : t("stats.addToChart")}>
      <span className="stats-dot" style={color ? { background: color } : undefined}/>
      <span className="stats-name">{seriesLabel(kind, item.key, item.label)}</span>
      <b>{size(item.bytes)}</b>
    </button>
    <div className="stats-track"><span style={{ width: `${share}%`, background: color || undefined }}/></div>
    <small>{files(item.count)} · {Math.round(share)} %{item.hosts && <> · <button className="link-button"
      aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? t("stats.showFewer") : t("stats.serverCount", { count: item.hosts.length })}
    </button></>}</small>
    {item.hosts && open && <ul className="stats-hosts">
      {item.hosts.map((host) => <li key={host.key}>
        <span className="stats-name">{host.label}</span> · <b>{size(host.bytes)}</b> · <small>{files(host.items)}</small>
      </li>)}
    </ul>}
  </li>;
}

/** A breakdown stays short: the first few rows, then one control for the rest. */
function Breakdown({ title, kind, items, chosen, onToggle, colors, cap }: {
  title: string; kind: string; items: StatsSummary["providers"];
  chosen: Set<string>; onToggle: (id: string) => void; colors: Map<string, string>; cap?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const total = items.reduce((sum, item) => sum + item.bytes, 0);
  const visible = cap !== undefined && !expanded ? items.slice(0, cap) : items;
  return <section className="panel stats-breakdown">
    <h3>{title}</h3>
    {!items.length ? <p className="stats-empty">{t("stats.emptyPeriod")}</p> : <>
      <ul>{visible.map((item) => <BreakdownRow key={item.key} kind={kind} item={item} total={total}
        chosen={chosen} onToggle={onToggle} colors={colors}/>)}</ul>
      {cap !== undefined && items.length > cap && <button className="link-button" onClick={() => setExpanded(!expanded)}>
        {expanded ? t("stats.showFewer") : t("stats.showAll", { count: items.length })}
      </button>}
    </>}
  </section>;
}

function Live({ streams, now }: { streams: ActiveStream[]; now: number }) {
  const rate = streams.reduce((sum, stream) => sum + stream.rate, 0);
  return <section className="panel stats-live">
    <div className="stats-live-head">
      <h3>{t("stats.live.title")}</h3>
      {streams.length > 0 && <span>{t("stats.live.count", { count: streams.length })} · {t("stats.live.rate", { rate: size(rate) })}</span>}
    </div>
    {!streams.length ? <p className="stats-empty">{t("stats.live.none")}</p> : <ul>
      {streams.map((stream) => {
        const stalled = !stream.rate && stream.idleSeconds >= SILENT_SECONDS;
        return <li key={stream.id}>
          <div className="stats-live-name">
            <span className={`stats-live-dot${stalled ? " stalled" : ""}`} aria-hidden="true"/>
            <b title={stream.title}>{stream.title}</b>
          </div>
          <div className="stats-live-tags">
            <span>{serverText(`stats.source.${stream.source}`, stream.source)}</span>
            <span>{t(`stats.mode.${stream.mode}`)}</span>
            {stream.quality !== null && <span>{t("stats.live.quality", { quality: stream.quality })}</span>}
            {stream.hardware && <span>{t("stats.live.hardware")}</span>}
            {(stream.addonName || stream.provider) && <span title={stream.provider}>{stream.addonName ?? stream.provider}</span>}
          </div>
          <div className="stats-live-flow">
            <b className={stream.rate ? undefined : "quiet"}>
              {stream.rate ? t("stats.live.rate", { rate: size(stream.rate) })
                : stalled ? t("stats.live.stalled") : t("stats.live.buffered")}
            </b>
            <small>{t("stats.live.transferred", { bytes: size(stream.bytes) })} · {t("stats.live.elapsed", { time: elapsed(stream.startedAt, now) })}</small>
          </div>
        </li>;
      })}
    </ul>}
  </section>;
}

function ActivityHistory({ hours, onError }: { hours: number; onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState("");
  const [user, setUser] = useState("");
  const [before, setBefore] = useState<number>();
  const [previous, setPrevious] = useState<Array<number | undefined>>([]);
  const [page, setPage] = useState<StatsActivityPage>();
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reset = () => { setBefore(undefined); setPrevious([]); };

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.activity(hours, kind, user, before)
      .then((data) => { if (alive) setPage(data); })
      .catch((error) => { if (alive) { setPage(undefined); onError(error); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [hours, kind, user, before, revision]);

  return <section className="panel stats-history" aria-busy={loading}>
    <div className="stats-history-head">
      <h3>{t("stats.history.title")}</h3>
      <div className="stats-history-filters">
        <label>{t("stats.history.kind")}<select value={kind} onChange={(event) => { setKind(event.target.value); reset(); }}>
          <option value="">{t("stats.history.all")}</option>
          {(["playback", "library", "device"] as const).map((value) => <option key={value} value={value}>{t(`stats.history.${value}`)}</option>)}
        </select></label>
        <label>{t("stats.history.user")}<select value={user} onChange={(event) => { setUser(event.target.value); reset(); }}>
          <option value="">{t("stats.history.allUsers")}</option>
          {page?.users.map((item) => <option key={item.id} value={item.id}>{item.username}</option>)}
        </select></label>
        <button disabled={loading} onClick={() => { reset(); setRevision((value) => value + 1); }}>{t("stats.history.refresh")}</button>
      </div>
    </div>
    <p className="stats-hint">{t("stats.history.hint")}</p>
    {loading ? <p>{t("common.loading")}</p> : !page?.items.length ? <p className="stats-empty">{t("stats.history.empty")}</p> : <>
      <ul className="stats-history-list">{page.items.map((item) => <li key={item.id}>
        <div><strong>{item.title}</strong>{item.filename && item.filename !== item.title && <small>{item.filename}</small>}</div>
        <div><span>{t(`stats.history.${item.kind}`)}{item.partial ? ` · ${t("stats.history.partial")}` : ""}</span><small>{item.username ?? t("stats.history.unknownUser")}</small></div>
        <div><time dateTime={item.at}>{new Date(item.at).toLocaleString(localeTag())}</time>{item.bytes !== undefined && <small>{size(item.bytes)}</small>}</div>
      </li>)}</ul>
      <div className="stats-history-pages">
        <span>{t("stats.items", { count: page.total })}</span>
        <button disabled={!previous.length} onClick={() => { setBefore(previous.at(-1)); setPrevious((values) => values.slice(0, -1)); }}>{t("stats.history.previous")}</button>
        <button disabled={!page.next} onClick={() => { setPrevious((values) => [...values, before]); setBefore(page.next); }}>{t("stats.history.next")}</button>
      </div>
    </>}
  </section>;
}

export function StatsPanel({ onError }: { onError: (error: unknown) => void }) {
  const { t } = useI18n();
  const [hours, setHours] = useState(720);
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [streams, setStreams] = useState<ActiveStream[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Polled rather than pushed: the page is open for a moment and a socket for this alone
  // would outweigh a request every five seconds. A failure only empties the panel -- the
  // statistics behind it are still worth showing.
  useEffect(() => {
    let alive = true;
    const tick = () => api.activeStreams()
      .then((data) => { if (alive) { setStreams(data); setNow(Date.now()); } })
      .catch(() => { if (alive) setStreams([]); });
    void tick();
    const timer = setInterval(tick, LIVE_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.stats(hours)
      .then((data) => { if (alive) setSummary(data); })
      .catch((error) => { if (alive) onError(error); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [hours]);

  const toggle = (id: string) => setChosen((current) => {
    const next = new Set(current);
    if (!next.delete(id)) next.add(id);
    return next;
  });

  // Only a picked series gets a colour, so the shades are not handed out at random by position.
  const { lines, colors } = useMemo(() => {
    const colors = new Map<string, string>();
    if (!summary) return { lines: [], colors };
    const pool = [
      ...summary.byProvider.map((line) => ({ ...line, id: `provider:${line.key}` })),
      ...summary.byAddon.map((line) => ({ ...line, id: `addon:${line.key}` })),
      ...summary.bySource.map((line) => ({ ...line, id: `source:${line.key}`, dashed: line.key === "library" })),
    ].filter((line) => chosen.has(line.id));
    const lines = pool.map((line, index) => {
      const color = COLORS[index % COLORS.length];
      colors.set(line.id, color);
      return { ...line, color };
    });
    return { lines, colors };
  }, [summary, chosen]);

  return <section className="stats-page">
    <div className="stats-head">
      <div>
        <h2>{t("stats.title")}</h2>
        <p>{summary?.since
          ? t("stats.lead", { since: new Date(summary.since).toLocaleDateString(localeTag()) })
          : t("stats.leadEmpty")}</p>
      </div>
      <div className="stats-periods" role="group" aria-label={t("stats.periodGroup")}>
        {PERIODS.map((period) => <button key={period.hours} className={period.hours === hours ? "active" : ""} onClick={() => setHours(period.hours)}>{t(period.key)}</button>)}
      </div>
    </div>

    <Live streams={streams} now={now}/>

    {!summary ? <p className="stats-empty">{loading ? t("common.loading") : t("stats.loadFailed")}</p> : <>
      <div className="stats-cards">
        <Card title={t("stats.card.hour")} window={summary.hour}/>
        <Card title={t("stats.card.day")} window={summary.day}/>
        <Card title={t("stats.card.week")} window={summary.week}/>
        <Card title={t("stats.card.month")} window={summary.month}/>
        <Card title={t("stats.card.total")} window={summary.total}/>
      </div>

      <section className="panel stats-graph">
        <div className="stats-graph-head">
          <h3>{lines.length ? t("stats.chosenTrend") : t("stats.periodTrend")}</h3>
          {lines.length > 0 && <div className="stats-legend">
            {lines.map((line) => <span key={line.id}><i style={{ background: line.color }}/>{line.label}</span>)}
            <button className="link-button" onClick={() => setChosen(new Set())}>{t("stats.clearSelection")}</button>
          </div>}
        </div>
        {summary.points.some((point) => point.bytes) || lines.length
          ? <Chart summary={summary} lines={lines}/>
          : <p className="stats-empty">{t("stats.noTraffic")}</p>}
      </section>

      <ActivityHistory key={hours} hours={hours} onError={onError}/>

      <p className="stats-hint">{t("stats.hint")}</p>

      <div className="stats-columns">
        <Breakdown title={t("stats.byProvider")} kind="provider" items={summary.providers} chosen={chosen} onToggle={toggle} colors={colors} cap={VISIBLE_ROWS}/>
        <Breakdown title={t("stats.byAddon")} kind="addon" items={summary.addons} chosen={chosen} onToggle={toggle} colors={colors} cap={VISIBLE_ROWS}/>
        <Breakdown title={t("stats.bySource")} kind="source" items={summary.sources} chosen={chosen} onToggle={toggle} colors={colors}/>
      </div>
    </>}
  </section>;
}
