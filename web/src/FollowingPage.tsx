import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
/** A film shows itself as a film; a series episode by its code. */
const codeOf = (item: { type: string; season: number; episode: number }): string => item.type === "movie" ? t("follow.movieBadge") : episodeCode(item.season, item.episode);
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
      const line = follow.type === "movie"
        ? follow.movie?.released ? t("follow.movieRelease", { date: formatDay(follow.movie.released) })
          : follow.movie?.theatricalAt ? t("follow.movieTheatrical", { date: formatDay(follow.movie.theatricalAt) }) : t("follow.movieUnannounced")
        : follow.nextEpisode
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

/** "neděle 4. října", never "Neděle 4. Října": only a sentence's first letter is raised. */
const sentence = (text: string) => text ? text[0]!.toLocaleUpperCase(localeTag()) + text.slice(1) : text;
const itemKey = (item: { followId: string; season: number; episode: number }) => `${item.followId}:${item.season}:${item.episode}`;

function StatePill({ state, children }: { state: CalendarEpisodeState; children?: ReactNode }) {
  return <span className={`state-pill state-${state}`}>{stateLabel(state)}{children}</span>;
}

function EpisodeRow({ item, onOpen }: { item: CalendarItem | UndatedCalendarItem; onOpen: () => void }) {
  return <button type="button" className="following-episode-row" title={item.dateUncertain ? t("following.dateUncertainHint") : undefined} onClick={onOpen}>
    <span className="following-episode-art">{item.poster ? <img src={item.poster} alt="" loading="lazy"/> : <Film/>}</span>
    <span className="following-episode-copy">
      <strong>{item.name}</strong>
      <small>{`${item.dateUncertain ? "≈ " : ""}${codeOf(item)}${item.title && item.type !== "movie" ? ` · ${item.title}` : ""}`}</small>
    </span>
    <StatePill state={item.state}/>
  </button>;
}

type CalendarMode = "agenda" | "month";
const MODE_KEY = "following-calendar-mode";
/** A phone opens on the list, anything wider on the month, until the viewer picks one. */
const initialMode = (): CalendarMode => {
  try { const stored = localStorage.getItem(MODE_KEY); if (stored === "agenda" || stored === "month") return stored; } catch { /* no storage */ }
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 700px)").matches ? "agenda" : "month";
};

function CalendarTab({ onOpenSeries }: { onOpenSeries: FollowingPageProps["onOpenSeries"] }) {
  useI18n();
  const [cursor, setCursor] = useState(() => new Date());
  const [selected, setSelected] = useState(() => dayKey(new Date()));
  const [mode, setMode] = useState<CalendarMode>(initialMode);
  const chooseMode = (next: CalendarMode) => {
    setMode(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* the choice only lives for this visit */ }
  };
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [undated, setUndated] = useState<UndatedCalendarItem[]>([]);
  const [loaded, setLoaded] = useState(false);

  const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const gridStart = addDays(monthStart, -mondayIndex(monthStart));
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const cells = Math.ceil((mondayIndex(monthStart) + daysInMonth) / 7) * 7;
  const rangeFrom = gridStart.getTime();
  const rangeTo = addDays(gridStart, cells).getTime();

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

  const today = dayKey(new Date());
  const tomorrow = dayKey(addDays(new Date(), 1));
  const goMonth = (offset: number) => {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + offset, 1);
    setCursor(next);
    // A month that holds today opens on today; any other on its first day with an episode.
    const holdsToday = next.getFullYear() === new Date().getFullYear() && next.getMonth() === new Date().getMonth();
    setSelected(holdsToday ? today : dayKey(next));
  };
  const goToday = () => { setCursor(new Date()); setSelected(today); };
  useEffect(() => {
    if (selected !== dayKey(monthStart) || byDay.has(selected)) return;
    const first = [...byDay.keys()].filter((key) => key.startsWith(selected.slice(0, 7))).sort()[0];
    if (first) setSelected(first);
  }, [byDay]);

  const monthPrefix = dayKey(monthStart).slice(0, 7);
  type AgendaEntry = { kind: "day"; key: string; date: Date; items: CalendarItem[] } | { kind: "today" };
  const agendaDays: AgendaEntry[] = [...byDay.entries()]
    .filter(([key]) => key.startsWith(monthPrefix))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, dayItems]) => ({ kind: "day" as const, key, date: new Date(`${key}T12:00:00`), items: dayItems }));
  // Today with nothing out still gets its place in the list, so "now" is never lost.
  if (today.startsWith(monthPrefix) && !byDay.has(today) && agendaDays.length) {
    const at = agendaDays.findIndex((entry) => entry.kind === "day" && entry.key > today);
    agendaDays.splice(at < 0 ? agendaDays.length : at, 0, { kind: "today" });
  }
  const openOf = (item: { type: string; metaId: string; name: string; poster?: string }) => onOpenSeries({ type: item.type, id: item.metaId, name: item.name, poster: item.poster });
  const monthLabel = sentence(new Intl.DateTimeFormat(localeTag(), { month: "long", year: "numeric" }).format(cursor));
  const selectedDate = new Date(`${selected}T12:00:00`);
  const longDay = new Intl.DateTimeFormat(localeTag(), { weekday: "long", day: "numeric", month: "long" }).format(selectedDate);
  const dayHeading = selected === today ? `${t("following.todayLabel")} · ${longDay}` : selected === tomorrow ? `${t("following.tomorrowLabel")} · ${longDay}` : sentence(longDay);
  const selectedItems = byDay.get(selected) ?? [];

  return <div className={`following-calendar-view ${mode}`}>
    <div className="following-cal-head">
      <h3 className="following-cal-title">{monthLabel}</h3>
      <div className="following-cal-mode" role="group" aria-label={t("following.calendarMode")}>
        {(["agenda", "month"] as const).map((value) => <button key={value} type="button" aria-pressed={mode === value} className={mode === value ? "active" : ""} onClick={() => chooseMode(value)}>{t(value === "agenda" ? "following.modeAgenda" : "following.modeMonth")}</button>)}
      </div>
      <div className="following-cal-nav" role="group" aria-label={monthLabel}>
        <button type="button" aria-label={t("following.prevMonth")} onClick={() => goMonth(-1)}><ChevronLeft/></button>
        <button type="button" onClick={goToday}>{t("following.today")}</button>
        <button type="button" aria-label={t("following.nextMonth")} onClick={() => goMonth(1)}><ChevronRight/></button>
      </div>
    </div>
    {mode === "agenda" ? <div className="following-agenda" aria-label={monthLabel}>
      {agendaDays.length ? agendaDays.map((entry) => entry.kind === "today"
        ? <div key="today-marker" className="following-agenda-now"><span>{t("following.todayLabel")}</span></div>
        : <section key={entry.key} className={`following-agenda-day${entry.key < today ? " past" : ""}${entry.key === today ? " today" : ""}`}>
          <div className="following-agenda-date" aria-hidden="true">
            <small>{new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(entry.date)}</small>
            <b>{entry.date.getDate()}</b>
          </div>
          <div className="following-agenda-items">
            <h4 className="visually-hidden">{sentence(new Intl.DateTimeFormat(localeTag(), { weekday: "long", day: "numeric", month: "long" }).format(entry.date))}</h4>
            {entry.items.map((item) => <EpisodeRow key={itemKey(item)} item={item} onOpen={() => openOf(item)}/>)}
          </div>
        </section>)
        : loaded && <p className="following-empty">{t("following.calendarEmpty")}</p>}
    </div> : <>
    <div className="following-month">
      <div className="following-calendar">
        {Array.from({ length: 7 }, (_, index) => <span className="following-weekday" key={index} aria-hidden="true">{new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(addDays(gridStart, index))}</span>)}
        {Array.from({ length: cells }, (_, index) => {
          const date = addDays(gridStart, index);
          const key = dayKey(date);
          const dayItems = byDay.get(key) ?? [];
          const classes = ["following-day", date.getMonth() !== cursor.getMonth() ? "outside" : "", key === today ? "today" : "", key === selected ? "selected" : "", dayItems.length ? "busy" : ""].filter(Boolean).join(" ");
          const label = `${new Intl.DateTimeFormat(localeTag(), { weekday: "long", day: "numeric", month: "long" }).format(date)}${dayItems.length ? `: ${dayItems.map((item) => `${item.name} ${codeOf(item)}`).join(", ")}` : ""}`;
          return <div key={key} className={classes}>
            <button type="button" className="following-day-hit" aria-label={label} aria-pressed={key === selected} onClick={() => setSelected(key)}>
              <span className="following-day-num">{date.getDate()}</span>
              {dayItems.length > 0 && <span className="following-day-dots" aria-hidden="true">
                {dayItems.slice(0, 4).map((item) => <i key={itemKey(item)} className={`state-${item.state}`}/>)}
                {dayItems.length > 4 && <b>+</b>}
              </span>}
            </button>
            {dayItems.length > 0 && <div className="following-day-items">
              {dayItems.slice(0, 3).map((item) => <button type="button" key={itemKey(item)} className={`following-event state-${item.state}`} title={item.dateUncertain ? t("following.dateUncertainHint") : `${item.name} ${codeOf(item)}${item.title ? ` · ${item.title}` : ""}`} onClick={() => openOf(item)}>
                {item.poster ? <img src={item.poster} alt="" loading="lazy"/> : null}
                <span><strong>{item.name}</strong><small>{`${item.dateUncertain ? "≈ " : ""}${codeOf(item)}`}</small></span>
              </button>)}
              {dayItems.length > 3 && <button type="button" className="following-event-more" onClick={() => setSelected(key)}>{t("following.more", { count: dayItems.length - 3 })}</button>}
            </div>}
          </div>;
        })}
      </div>
    </div>
    <div className="following-legend" role="group" aria-label={t("following.legend")}>
      {LEGEND.map((state) => <span key={state}><i className={`state-${state}`}/>{stateLabel(state)}</span>)}
    </div>
    <section className="following-day-panel" aria-live="polite">
      <h4>{dayHeading}</h4>
      {selectedItems.length
        ? selectedItems.map((item) => <EpisodeRow key={itemKey(item)} item={item} onOpen={() => openOf(item)}/>)
        : <p className="following-empty">{loaded && !items.some((item) => dayKey(new Date(item.released)).startsWith(dayKey(monthStart).slice(0, 7))) ? t("following.calendarEmpty") : t("following.dayEmpty")}</p>}
    </section>
    </>}
    {undated.length > 0 && <section className="following-day-panel following-undated">
      <h4>{t("following.dateUnknown")}</h4>
      {undated.map((item) => <EpisodeRow key={itemKey(item)} item={item} onOpen={() => openOf(item)}/>)}
    </section>}
  </div>;
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
        <span className="following-activity-copy"><strong>{`${item.name} · ${codeOf(item)}${item.title ? ` · ${item.title}` : ""}`}</strong>
          <span className="following-activity-meta"><StatePill state={item.state}/>{item.reasonKey && item.state !== "skipped" ? <small>{serverText(item.reasonKey, "")}</small> : null}{item.state === "waiting" && item.nextAttemptAt ? <small>{t("follow.nextAttempt", { time: formatWhen(item.nextAttemptAt) })}</small> : null}</span>
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
