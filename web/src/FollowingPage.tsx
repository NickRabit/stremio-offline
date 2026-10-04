import { useEffect, useMemo, useRef, useState } from "react";
import { BellRing, ChevronLeft, ChevronRight, Film } from "lucide-react";
import { api, describeError } from "./api";
import { FollowDialog } from "./FollowDialog";
import { Heading } from "./settings-ui";
import { localeTag, serverText, t, useI18n } from "./i18n";
import type { ActivityItem, Addon, CalendarEpisodeState, CalendarItem, UndatedCalendarItem, FollowView, LibraryView, NewEpisode } from "./types";

interface FollowingPageProps {
  follows: FollowView[];
  /** Kept for the caller's shape; the page itself reads the two episodes off each follow. */
  newEpisodes: NewEpisode[];
  languages: Array<{ code: string; name: string }>;
  libraries: LibraryView[];
  addons: Addon[];
  audioLanguage: string;
  subtitleLanguage: string;
  onChanged: (id: string, follow: FollowView | null) => void;
  onOpenSeries: (item: { type: string; id: string; name: string; poster?: string }) => void;
  onNotify: (text: string) => void;
}

const TABS = ["overview", "calendar", "activity"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL = { overview: "following.tabOverview", calendar: "following.tabCalendar", activity: "following.tabActivity" } as const;

const pad2 = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
const episodeCode = (season: number, episode: number) => `S${pad2(season)}E${pad2(episode)}`;
const formatDay = (value?: string) => value ? new Date(value).toLocaleDateString(localeTag()) : "";
const formatWhen = (value?: string) => value ? new Date(value).toLocaleString(localeTag(), { dateStyle: "short", timeStyle: "short" }) : "";

const addDays = (value: Date, days: number) => new Date(value.getFullYear(), value.getMonth(), value.getDate() + days);
const mondayIndex = (value: Date) => (value.getDay() + 6) % 7;
const dayKey = (value: Date) => `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;

/** Every queue state as one label; the calendar adds its own released/upcoming verdicts. */
const stateLabel = (state: CalendarEpisodeState) => t(
  state === "upcoming" ? "following.stateUpcoming"
  : state === "released" ? "following.stateReleased"
  : state === "waiting" ? "follow.stateWaiting"
  : state === "completed" ? "follow.stateCompleted"
  : state === "skipped" ? "follow.stateSkipped"
  : state === "attention" ? "follow.stateAttention"
  : "follow.stateQueued");

const LEGEND: CalendarEpisodeState[] = ["upcoming", "released", "queued", "waiting", "completed", "attention", "skipped"];

const DAY_MS = 24 * 60 * 60_000;

export function FollowingPage({ follows, languages, libraries, addons, audioLanguage, subtitleLanguage, onChanged, onOpenSeries, onNotify }: FollowingPageProps) {
  useI18n();
  const [tab, setTab] = useState<Tab>("overview");
  const [openId, setOpenId] = useState<string | null>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const open = follows.find((follow) => follow.id === openId) ?? null;

  const moveTab = (from: Tab, direction: 1 | -1) => {
    const next = TABS[(TABS.indexOf(from) + direction + TABS.length) % TABS.length];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return <section className="following-page">
    <Heading eyebrow={t("following.eyebrow")} title={t("following.title")}/>
    <div className="following-tabs" role="tablist" aria-label={t("following.title")}>
      {TABS.map((name) => <button key={name} role="tab" type="button" id={`following-tab-${name}`} aria-selected={tab === name}
        aria-controls={`following-panel-${name}`} tabIndex={tab === name ? 0 : -1} className={tab === name ? "active" : ""}
        ref={(node) => { tabRefs.current[name] = node; }}
        onClick={() => setTab(name)}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") { event.preventDefault(); moveTab(name, 1); }
          else if (event.key === "ArrowLeft") { event.preventDefault(); moveTab(name, -1); }
        }}>{t(TAB_LABEL[name])}</button>)}
    </div>
    <div className="following-panel" role="tabpanel" id={`following-panel-${tab}`} aria-labelledby={`following-tab-${tab}`} tabIndex={0}>
      {tab === "overview" && <Overview follows={follows} onOpen={setOpenId}/>}
      {tab === "calendar" && <CalendarTab onOpenSeries={onOpenSeries}/>}
      {tab === "activity" && <ActivityTab onNotify={onNotify}/>}
    </div>
    {open && <FollowDialog follow={open} languages={languages} libraries={libraries} addons={addons}
      audioLanguage={audioLanguage} subtitleLanguage={subtitleLanguage}
      onChanged={(updated) => onChanged(open.id, updated)} onClose={() => setOpenId(null)} onNotify={onNotify}/>}
  </section>;
}

const sortFollows = (follows: FollowView[]): FollowView[] => [...follows].sort((left, right) => {
  const attention = (follow: FollowView) => follow.downloads.attention > 0 ? 0 : 1;
  if (attention(left) !== attention(right)) return attention(left) - attention(right);
  const next = (follow: FollowView) => follow.nextEpisode?.released ? Date.parse(follow.nextEpisode.released) : Infinity;
  if (next(left) !== next(right)) return next(left) - next(right);
  return left.name.localeCompare(right.name);
});

function Overview({ follows, onOpen }: { follows: FollowView[]; onOpen: (id: string) => void }) {
  useI18n();
  if (!follows.length) return <div className="empty"><i><BellRing/></i><h3>{t("following.emptyTitle")}</h3><p>{t("following.emptyText")}</p></div>;
  return <div className="following-grid">
    {sortFollows(follows).map((follow) => {
      const line = follow.nextEpisode
        ? t("follow.nextEpisode", { code: episodeCode(follow.nextEpisode.season, follow.nextEpisode.episode), date: formatDay(follow.nextEpisode.released) })
        : follow.latestEpisode
          ? t("follow.latestEpisode", { code: episodeCode(follow.latestEpisode.season, follow.latestEpisode.episode), date: formatDay(follow.latestEpisode.released) })
          : t("follow.noNextEpisode");
      const countParts = [
        follow.downloads.queued ? t("follow.countQueued", { count: follow.downloads.queued }) : "",
        follow.downloads.waiting ? t("follow.countWaiting", { count: follow.downloads.waiting }) : "",
        follow.downloads.completed ? t("follow.countCompleted", { count: follow.downloads.completed }) : "",
      ].filter(Boolean);
      return <button type="button" className="following-card" key={follow.id} onClick={() => onOpen(follow.id)}>
        <span className="following-card-art">{follow.poster ? <img src={follow.poster} alt="" loading="lazy"/> : <Film/>}</span>
        <span className="following-card-copy">
          <strong>{follow.name}</strong>
          <small className="following-card-line">{line}</small>
          <span className="following-chips">
            {follow.autoDownload && <span className="following-chip">{t("follow.autoJob")}</span>}
            {!follow.enabled && <span className="following-chip paused">{t("follow.pausedBadge")}</span>}
            {follow.downloads.attention > 0 && <span className="following-chip attention">{t("following.attentionCount", { count: follow.downloads.attention })}</span>}
          </span>
          {countParts.length > 0 && <small className="following-counts">{t("follow.counts", { parts: countParts.join(" · ") })}</small>}
        </span>
      </button>;
    })}
  </div>;
}

function CalendarTab({ onOpenSeries }: { onOpenSeries: FollowingPageProps["onOpenSeries"] }) {
  useI18n();
  const [cursor, setCursor] = useState(() => new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [undated, setUndated] = useState<UndatedCalendarItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [wide, setWide] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 900px)").matches : true);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(min-width: 900px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  const gridStart = addDays(monthStart, -mondayIndex(monthStart));
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((mondayIndex(monthStart) + daysInMonth) / 7) * 7;
  const rangeFrom = wide ? gridStart.getTime() : monthStart.getTime();
  const rangeTo = wide ? addDays(gridStart, cells).getTime() : monthEnd.getTime();

  useEffect(() => { setExpanded(new Set()); }, [cursor, wide]);

  useEffect(() => {
    let stale = false;
    // The server windows in UTC and the days here are local, so a day either side keeps an
    // episode near midnight from falling between the two; the buckets drop what is off-screen.
    api.followCalendar(rangeFrom - DAY_MS, rangeTo + DAY_MS)
      .then((rows) => { if (!stale) { setItems(rows.items); setUndated(rows.undated); setLoaded(true); } })
      .catch(() => { if (!stale) { setItems([]); setUndated([]); setLoaded(true); } });
    return () => { stale = true; };
  }, [rangeFrom, rangeTo]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) {
      const key = dayKey(new Date(item.released));
      const list = map.get(key);
      if (list) list.push(item); else map.set(key, [item]);
    }
    return map;
  }, [items]);

  const openOf = (item: { type: string; metaId: string; name: string; poster?: string }) => onOpenSeries({ type: item.type, id: item.metaId, name: item.name, poster: item.poster });
  const uncertain = (item: { dateUncertain?: boolean }) => item.dateUncertain ? t("following.dateUncertainHint") : undefined;
  const monthLabel = new Intl.DateTimeFormat(localeTag(), { month: "long", year: "numeric" }).format(cursor);
  const today = dayKey(new Date());
  const tomorrow = dayKey(addDays(new Date(), 1));

  return <>
    <div className="following-cal-head">
      <div className="following-cal-nav">
        <button type="button" className="icon-button" aria-label={t("following.prevMonth")} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}><ChevronLeft/></button>
        <button type="button" onClick={() => setCursor(new Date())}>{t("following.today")}</button>
        <button type="button" className="icon-button" aria-label={t("following.nextMonth")} onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}><ChevronRight/></button>
      </div>
      <h3 className="following-cal-title">{monthLabel}</h3>
    </div>
    <div className="following-legend" role="group" aria-label={t("following.legend")}>
      {LEGEND.map((state) => <span key={state}><i className={`cal-${state}`}/>{stateLabel(state)}</span>)}
    </div>
    {wide
      ? <div className="following-calendar">
          {Array.from({ length: 7 }, (_, index) => <span className="following-weekday" key={index}>{new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(addDays(gridStart, index))}</span>)}
          {Array.from({ length: cells }, (_, index) => {
            const date = addDays(gridStart, index);
            const key = dayKey(date);
            const dayItems = byDay.get(key) ?? [];
            const open = expanded.has(key);
            const shown = open ? dayItems : dayItems.slice(0, 3);
            return <div key={key} className={`following-day${date.getMonth() !== cursor.getMonth() ? " outside" : ""}${key === today ? " today" : ""}`}>
              <span className="following-day-num">{date.getDate()}</span>
              <div className="following-day-items">
                {shown.map((item) => <button type="button" key={`${item.followId}:${item.season}:${item.episode}`} className={`following-cal-item cal-${item.state}`} title={uncertain(item)} onClick={() => openOf(item)}>{`${item.dateUncertain ? "≈ " : ""}${item.name} ${episodeCode(item.season, item.episode)}`}</button>)}
                {!open && dayItems.length > 3 && <button type="button" className="following-cal-more" onClick={() => setExpanded((current) => new Set(current).add(key))}>{t("following.more", { count: dayItems.length - 3 })}</button>}
              </div>
            </div>;
          })}
        </div>
      : <div className="following-agenda">
          {[...byDay.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, dayItems]) => <div className="following-agenda-day" key={key}>
            <h4>{key === today ? t("following.todayLabel") : key === tomorrow ? t("following.tomorrowLabel") : new Intl.DateTimeFormat(localeTag(), { weekday: "long", day: "numeric", month: "long" }).format(new Date(dayItems[0].released))}</h4>
            {dayItems.map((item) => <button type="button" className="following-agenda-row" key={`${item.followId}:${item.season}:${item.episode}`} title={uncertain(item)} onClick={() => openOf(item)}>
              <span className="following-agenda-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}</span>
              <span className="following-agenda-copy"><strong>{`${item.dateUncertain ? "≈ " : ""}${item.name}`}</strong><small>{`${episodeCode(item.season, item.episode)}${item.title ? ` · ${item.title}` : ""}`}</small></span>
              <span className={`following-state cal-${item.state}`}>{stateLabel(item.state)}</span>
            </button>)}
          </div>)}
        </div>}
    {undated.length > 0 && <div className="following-undated">
      <h4>{t("following.dateUnknown")}</h4>
      {undated.map((item) => <button type="button" className="following-agenda-row" key={`${item.followId}:${item.season}:${item.episode}`} title={uncertain(item)} onClick={() => openOf(item)}>
        <span className="following-agenda-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}</span>
        <span className="following-agenda-copy"><strong>{`≈ ${item.name}`}</strong><small>{`${episodeCode(item.season, item.episode)}${item.title ? ` · ${item.title}` : ""}`}</small></span>
        <span className={`following-state cal-${item.state}`}>{stateLabel(item.state)}</span>
      </button>)}
    </div>}
    {loaded && !items.length && !undated.length && <p className="following-empty">{t("following.calendarEmpty")}</p>}
  </>;
}

function ActivityTab({ onNotify }: { onNotify: (text: string) => void }) {
  useI18n();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let stale = false;
    api.followActivity()
      .then((rows) => { if (!stale) { setItems(rows); setLoaded(true); } })
      .catch(() => { if (!stale) { setItems([]); setLoaded(true); } });
    return () => { stale = true; };
  }, [reload]);

  const act = async (run: () => Promise<void>) => {
    try { await run(); setReload((value) => value + 1); }
    catch (error) { onNotify(describeError(error)); }
  };

  if (loaded && !items.length) return <p className="following-empty">{t("following.activityEmpty")}</p>;
  return <div className="following-activity">
    {items.map((item) => {
      // An activity row carries no episode key; the store names a slot `${season}:${episode}`.
      const key = `${item.season}:${item.episode}`;
      const canSkip = item.state === "reserved" || item.state === "queued" || item.state === "waiting";
      const canRetry = item.state === "waiting" || item.state === "attention" || item.state === "skipped";
      return <div className="following-activity-row" key={`${item.followId}:${key}`}>
        <span className="following-activity-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}</span>
        <span className="following-activity-copy"><strong>{`${item.name} · ${episodeCode(item.season, item.episode)}${item.title ? ` · ${item.title}` : ""}`}</strong>
          <span className={`following-state cal-${item.state}`}>{stateLabel(item.state)}{item.reasonKey ? ` · ${serverText(item.reasonKey, "")}` : ""}{item.state === "waiting" && item.nextAttemptAt ? ` · ${t("follow.nextAttempt", { time: formatWhen(item.nextAttemptAt) })}` : ""}</span>
        </span>
        <small className="following-activity-time">{formatWhen(item.updatedAt)}</small>
        <span className="following-activity-actions">
          {canSkip && <button type="button" onClick={() => void act(() => api.skipFollowEpisode(item.followId, key))}>{t("follow.skip")}</button>}
          {canRetry && <button type="button" onClick={() => void act(() => api.retryFollowEpisode(item.followId, key))}>{t("follow.retry")}</button>}
        </span>
      </div>;
    })}
  </div>;
}
