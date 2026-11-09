const HOURS_MINUTES = /^(\d+)\s*h(?:ours?|rs?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/i;
const MINUTES_ONLY = /^(\d+)\s*m(?:in(?:utes?)?)?$/i;
const ISO_DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i;

/** Minutes from a meta's `runtime`, read the way the server's library matching reads it:
 *  a number, "85 min", "1h 25min", "1 h 25 min" or "PT85M". */
export function runtimeMinutes(raw: unknown): number | undefined {
  let minutes: number | undefined;
  if (typeof raw === "number") minutes = raw;
  else if (typeof raw === "string") {
    const text = raw.trim();
    const iso = ISO_DURATION.exec(text);
    const hours = HOURS_MINUTES.exec(text);
    const only = MINUTES_ONLY.exec(text);
    minutes = iso && (iso[1] || iso[2]) ? Number(iso[1] ?? 0) * 60 + Number(iso[2] ?? 0)
      : hours ? Number(hours[1]) * 60 + Number(hours[2] ?? 0)
      : only ? Number(only[1]) : undefined;
  }
  return minutes != null && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : undefined;
}

const unit = (locale: string, name: "hour" | "minute", value: number) =>
  new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short" }).format(value);

/** A run time in the reader's units, "2 h 16 min"; the browser supplies the words. */
export function formatRuntime(minutes: number, locale: string): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (!hours) return unit(locale, "minute", rest);
  return rest ? `${unit(locale, "hour", hours)} ${unit(locale, "minute", rest)}` : unit(locale, "hour", hours);
}

/** The detail's run time: formatted when it parses, the addon's own short text otherwise. */
export function runtimeLabel(raw: unknown, locale: string): string | undefined {
  const minutes = runtimeMinutes(raw);
  if (minutes != null) return formatRuntime(minutes, locale);
  const text = typeof raw === "string" ? raw.trim() : "";
  return text && text.length <= 24 ? text : undefined;
}
