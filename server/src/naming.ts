import { AppError } from "./errors.js";
import path from "node:path";
import type { AddonDownloadSettings, DownloadLayout, DownloadTargetSettings, StreamItem } from "./types.js";
import type { LibraryRecord } from "./libraries.js";

export interface MediaInfo {
  /** The IMDb id from the catalogue, so metadata need not be guessed from the folder name. */
  id?: string;
  metaType?: string;
  /** The poster from the catalogue. The client has it at hand, so it need not be looked up through metadata. */
  poster?: string;
  kind?: "movie" | "episode";
  /** The film's name, or the series name for an episode. */
  title?: string;
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

// The backslash is here for Windows shares, and also so a name cannot be used to
// escape the target directory.
const FORBIDDEN = /[\u0000-\u001f/:*?"<>|\\]/g;
/** Windows refuses these stems whatever follows them, so `CON.mkv` is a file nobody there can
 *  create. An underscore in front keeps the name recognisable and makes it legal again. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function safeName(value: string): string {
  const cleaned = value.normalize("NFC")
    .replace(FORBIDDEN, " ")
    // Stripping the slashes from "../.." leaves lone dots, which make no sense as part of a name.
    .split(/\s+/).filter((part) => part && !/^\.+$/.test(part)).join(" ")
    .replace(/^\.+/, "").replace(/\.+$/, "").trim();
  const stem = cleaned.split(".")[0] ?? "";
  const named = RESERVED.test(stem) ? `_${cleaned}` : cleaned;
  return named.slice(0, 150).trim() || "video";
}

/** The tidying nobody would call a rename: the same characters, composed the same way,
 *  with runs of whitespace collapsed. */
const tidyName = (value: string) => value.normalize("NFC").split(/\s+/).filter(Boolean).join(" ");

/** For a name somebody typed. `safeName` quietly rewrites whatever it cannot use, which for
 *  a rename means the item ends up called something else than was asked for; refuse instead,
 *  and let the interface say so. */
export function assertUsableName(value: string): string {
  const tidied = tidyName(value);
  if (!tidied) throw new AppError("The name cannot be empty.", "err.emptyName");
  if (tidied.length > 150) throw new AppError("The name can be at most 150 characters long.", "err.nameTooLong");
  const safe = safeName(tidied);
  if (safe !== tidied) {
    throw new AppError(
      "That name cannot be used. Leave out / \\ : * ? \" < > |, do not begin or end with a dot, and avoid device names such as CON or NUL.",
      "err.unusableName");
  }
  return safe;
}

const pad = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");

export const defaultDownloadSettings = (): AddonDownloadSettings => ({
  movie: { subfolder: "", layout: "structured" },
  series: { subfolder: "", layout: "structured" },
});

/** The subfolder is relative to the root of the library the rule names. Several levels are
 *  allowed, but never an absolute path, a drive letter, or . and .. segments. */
export function safeSubfolder(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^[\\/]/.test(raw) || /^[a-z]:/i.test(raw)) throw new AppError("The subfolder has to be relative to the library's root.", "err.subfolderRelative");
  const segments = raw.split(/[\\/]+/).filter(Boolean);
  if (segments.length > 8) throw new AppError("The subfolder can be at most 8 levels deep.", "err.subfolderDepth");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new AppError("The subfolder cannot contain . or .. segments.", "err.subfolderDots");
  return segments.map(safeName).join(path.sep);
}

/** The library a rule names, or the reason it cannot be used. Called with the libraries a
 *  request is up against (`store.libraries()`), so the editor and the route agree on what a
 *  writable destination is. Without them the id is kept as it stands: the queue resolves it
 *  when the job starts, where a library that went away must not fail the download. */
const targetLibrary = (id: string, kind: "movie" | "series", libraries?: LibraryRecord[]): string | undefined => {
  if (!id || !libraries) return id || undefined;
  const library = libraries.find((item) => item.id === id);
  if (!library) throw new AppError("That library does not exist.", "err.libraryNotFound");
  if (library.type !== kind && library.type !== "mixed") throw new AppError("That library does not take this kind of title.", "err.libraryTypeMismatch");
  if (!library.enabled || library.readOnly || library.unreachable) {
    throw new AppError("That library is switched off, read-only or not reachable right now.", "err.libraryNotWritable");
  }
  return id;
};

const targetSettings = (value: unknown, kind: "movie" | "series", libraries?: LibraryRecord[]): DownloadTargetSettings => {
  const item = typeof value === "object" && value ? value as Record<string, unknown> : {};
  const layout: DownloadLayout = item.layout === "flat" ? "flat" : "structured";
  const libraryId = targetLibrary(String(item.libraryId ?? "").trim(), kind, libraries);
  return { subfolder: safeSubfolder(item.subfolder), layout, ...(libraryId ? { libraryId } : {}) };
};

export function normalizeDownloadSettings(value: unknown, libraries?: LibraryRecord[]): AddonDownloadSettings {
  const item = typeof value === "object" && value ? value as Record<string, unknown> : {};
  return { movie: targetSettings(item.movie, "movie", libraries), series: targetSettings(item.series, "series", libraries) };
}

/** A film goes into a folder of its own, an episode into the series and season folders. Media libraries expect that. */
export function targetPath(media: MediaInfo | undefined, fallbackTitle: string, extension: string, settings: DownloadTargetSettings = defaultDownloadSettings().movie): { directory: string; base: string } {
  const prefix = safeSubfolder(settings.subfolder);
  if (media?.kind === "episode" && media.title?.trim()) {
    const series = safeName(media.title);
    const number = media.episode == null ? "" : pad(media.episode);
    const name = media.episodeTitle?.trim() ? safeName(media.episodeTitle) : "";
    if (settings.layout === "flat") {
      const episodeCode = media.season == null ? number : `S${pad(media.season)}E${number || "00"}`;
      const base = [series, episodeCode, name].filter(Boolean).join(" - ") || safeName(fallbackTitle);
      return { directory: prefix, base };
    }
    const directory = path.join(prefix, series, ...(media.season == null ? [] : [`${pad(media.season)} serie`]));
    const base = [number, name].filter(Boolean).join(" - ") || safeName(fallbackTitle);
    return { directory, base };
  }
  const title = safeName(media?.title?.trim() || fallbackTitle);
  return { directory: settings.layout === "flat" ? prefix : path.join(prefix, title), base: title };
}

export const joinTarget = (directory: string, base: string, extension: string, copy = 1) =>
  path.join(directory, `${base}${copy > 1 ? ` (${copy})` : ""}${extension}`);

/** Derive extensions in one place for both library and device downloads. */
export function streamExtension(stream: StreamItem): string {
  const hinted = stream.behaviorHints?.filename;
  const source = hinted ?? (stream.url ? new URL(stream.url).pathname : "");
  const extension = path.extname(source).toLowerCase();
  // A playlist is assembled into one MP4, so that is what lands in the library;
  // naming the file after the list would leave something nothing can open.
  if (extension === ".m3u8") return ".mp4";
  return path.extname(source) || ".mp4";
}

/** Browsers cannot preserve server folders, but the basename must match a library download. */
export function deviceFilename(stream: StreamItem, media: MediaInfo | undefined, fallbackTitle: string, settings: DownloadTargetSettings): string {
  const extension = streamExtension(stream);
  const { directory, base } = targetPath(media, fallbackTitle, extension, settings);
  return path.basename(joinTarget(directory, base, extension));
}
