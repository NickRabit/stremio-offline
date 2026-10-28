import { containerExtension, nameExtension } from "./naming.js";
import { normalizeLanguage } from "./language.js";
import {
  ARTWORK_TAG,
  MediaServerError,
  MEDIA_SERVER_KINDS,
  MEDIA_SERVER_LIMITS,
  validateMediaServerToken,
  type MediaServerKind,
  type RemoteLibraryType,
} from "./media-server-types.js";
import type { MediaServerTransport } from "./media-server-security.js";

/** Facts read from a remote account policy. This is not an authorization decision: an unknown
 *  field is not proof of permission, and `hasAdditionalRestrictions` is never exhaustive. */
export interface RemoteAccountPolicy {
  disabled: boolean;
  mediaPlayback: boolean;
  /** Whether the account may download content at all. Absent when the server did not report the
   *  field: a missing fact is not a permission, so it never permits a copy. Local to download
   *  admission and never consulted for ordinary playback. */
  contentDownloading?: boolean;
  allFolders: boolean;
  folderIds: string[];
  hasAdditionalRestrictions: boolean;
  /** Remote bitrate the account may stream at, in bits per second. Absent when unlimited. */
  bitrateLimit?: number;
  /** Concurrent streams the account may hold. Absent when unlimited. */
  streamLimit?: number;
}

export interface ProviderLibrary {
  id: string;
  name: string;
  type: RemoteLibraryType;
  /** The view's own Primary image tag, when the server reports one, so a library tile can prefer
   *  its own poster without traversing a child. Never part of a client projection. */
  primaryImageTag?: string;
}

export type ProviderItemType = "movie" | "series" | "season" | "episode" | "folder";

/** A folder is navigable but never playable and never a catalogue match. */
export const PLAYABLE_ITEM_TYPES: readonly ProviderItemType[] = ["movie", "episode"];

export type ProviderSort = "name" | "added" | "size";
export type ProviderOrder = "asc" | "desc";
export const PROVIDER_SORTS: readonly ProviderSort[] = ["name", "added", "size"];
export const PROVIDER_ORDERS: readonly ProviderOrder[] = ["asc", "desc"];

/** One native browse page: exactly the arguments a client may choose, mapped one-to-one onto
 *  the fixed transport operation. `mode` decides `Recursive` and whether `Folder` is admitted. */
export interface ProviderDirectoryOptions {
  mode: "folders" | "titles";
  limit?: number;
  cursor?: string;
  search?: string;
  type?: ProviderItemType;
  /** A root-scoped recursive title search. When set, `type` must be absent and the mode
   *  must be `titles`. */
  searchTypes?: "movie" | "series" | "all";
  sort?: ProviderSort;
  order?: ProviderOrder;
  /** The bounded `ParentIndexNumber` of a season page: one episode page for exactly that season. */
  season?: number;
}

export const DIRECTORY_MEDIA_TYPES = "Movie,Series,Season,Episode,MusicVideo";
export const DIRECTORY_FOLDER_TYPES = `Folder,${DIRECTORY_MEDIA_TYPES}`;
export const DIRECTORY_TITLE_TYPES = "Movie,Series,MusicVideo";

export interface ProviderItem {
  id: string;
  name: string;
  type: ProviderItemType;
  parentId?: string;
  seriesId?: string;
  /** The series an episode belongs to, as the server names it; no request is needed for it. */
  seriesName?: string;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  providerIds: { imdb?: string; tmdb?: string; tvdb?: string };
  durationTicks?: number;
  overview?: string; year?: number; genres?: string[]; size?: number; addedAt?: string;
  /** Internal only: whether the provider row carries an actual Primary image tag. Never part of
   *  a client projection; the mosaic preview uses it to prefer tiles that have real artwork. */
  hasPrimaryImage?: boolean;
  /** Internal only: whether the provider row carries an actual Backdrop image. Never part of a
   *  client projection; the item projection omits the wide path only when this is explicitly
   *  false, so a row that never reported image metadata keeps the legacy path. */
  hasBackdropImage?: boolean;
  /** Internal only: whether the provider row carries an actual Thumb image. Never part of a
   *  client projection; a wide tile draws the provider's landscape still when there is one. */
  hasThumbImage?: boolean;
  /** Internal only: the exact Primary image tag the row reported, so the client URL can request
   *  that version and a 404 proves the membership is gone. Never part of a client projection. */
  primaryImageTag?: string;
  /** Internal only: the exact Backdrop image tag the row reported, read from BackdropImageTags or
   *  the legacy ImageTags.Backdrop. Never part of a client projection. */
  backdropImageTag?: string;
  /** Internal only: the exact Thumb image tag the row reported, read from the legacy
   *  ImageTags.Thumb. Never part of a client projection. */
  thumbImageTag?: string;
  /** The bounded number of children the row reports, when the server calculates one. */
  childCount?: number;
}

export interface ProviderPage {
  items: ProviderItem[];
  total: number;
  cursor?: string;
}

export interface ProviderVersion {
  id: string;
  name?: string;
  container?: string;
  size?: number;
  durationTicks?: number;
  bitrate?: number;
  videoWidth?: number;
  videoHeight?: number;
  audioLanguages?: Array<string | undefined>;
  embeddedSubtitleLanguages?: Array<string | undefined>;
  /** External text subtitles the provider offers for this exact file version. */
  externalSubtitles?: Array<{ index: number; language?: string; title?: string }>;
}

export interface ProviderPlaybackSource {
  id: string;
  bitrate?: number;
  supportsDirectPlay: boolean;
  supportsDirectStream: boolean;
  supportsTranscoding: boolean;
}

export interface ProviderPlaybackInfo {
  mediaSources: ProviderPlaybackSource[];
  playSessionId?: string;
  errorCode?: "NotAllowed" | "NoCompatibleStream" | "RateLimitExceeded";
}

export interface ProviderPlaybackReport {
  kind: "playing" | "progress" | "stopped";
  mediaSourceId: string;
  playSessionId: string;
  positionTicks: number;
  isPaused: boolean;
  eventName?: "TimeUpdate" | "Pause" | "Unpause";
}

export interface MediaServerProvider {
  verifyIdentity(signal?: AbortSignal): Promise<{ serverId: string; version: string }>;
  authenticate(username: string, password: string, signal?: AbortSignal): Promise<{ serverId: string; accountId: string; token: string }>;
  logout(token: string, signal?: AbortSignal): Promise<void>;
  currentAccount(token: string, accountId: string, signal?: AbortSignal): Promise<{ accountId: string; policy: RemoteAccountPolicy }>;
  listLibraries(token: string, accountId: string, signal?: AbortSignal): Promise<ProviderLibrary[]>;
  pageItems(token: string, accountId: string, libraryId: string, options?: { cursor?: string; limit?: number; search?: string }, signal?: AbortSignal): Promise<ProviderPage>;
  /** One native browse page of `parentId`: a folder's children or a library's titles. The
   *  options map strictly onto the fixed transport operation; one page per request, no scan. */
  pageDirectory(token: string, accountId: string, parentId: string, options: ProviderDirectoryOptions, signal?: AbortSignal): Promise<ProviderPage>;
  detail(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderItem>;
  ancestors(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<string[]>;
  versions(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderVersion[]>;
  playbackInfo(
    token: string,
    accountId: string,
    itemId: string,
    options: {
      mediaSourceId?: string;
      maxStreamingBitrate?: number;
      isPlayback: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ProviderPlaybackInfo>;
  reportPlayback(token: string, itemId: string, report: ProviderPlaybackReport, signal?: AbortSignal): Promise<void>;
  /** Resolve a catalogue id to the one library item that carries it: exactly one bounded list
   *  query, with every returned row re-checked locally for the exact provider id. Emby answers
   *  `AnyProviderIdEquals`; Jellyfin answers a `Has<Name>Id` page narrowed by the caller's title. */
  findByProviderIds(
    token: string,
    accountId: string,
    libraryId: string,
    ids: { imdb?: string; tmdb?: string; tvdb?: string },
    type: "movie" | "series",
    nameHint?: string,
    signal?: AbortSignal,
  ): Promise<ProviderItem[]>;
}

const LIBRARIES_MAX = MEDIA_SERVER_LIMITS.libraries;
const ANCESTORS_MAX = 128;
const VERSIONS_MAX = 200;
const EXTERNAL_SUBTITLES_MAX = 64;
const SUBTITLE_INDEX_MAX = 1023;
const SUBTITLE_TEXT_CODECS = new Set(["subrip", "srt"]);
const PLAY_SESSION_ID = /^[0-9a-f]{32}$/;
const PLAYBACK_ERROR_CODES = new Set<NonNullable<ProviderPlaybackInfo["errorCode"]>>(["NotAllowed", "NoCompatibleStream", "RateLimitExceeded"]);
const PROVIDER_ID_MAX = 512;
const CURSOR_MAX = 8192;
const CURSOR_JSON_BYTES_MAX = 6144;
const CURSOR_OFFSET_MAX = 1_000_000_000;
const SEARCH_MAX = 256;
const DIRECTORY_LIMIT_DEFAULT = 60;
const SEASON_MAX = 10_000;
const MATCH_LIMIT = 200;

const invalid = (message: string): MediaServerError => new MediaServerError("invalid-input", message);
const invalidResponse = (message: string): MediaServerError => new MediaServerError("invalid-response", message);

const asObject = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse(`${context} is malformed.`);
  return value as Record<string, unknown>;
};

const requiredString = (value: unknown, max: number, field: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalidResponse(`The media-server ${field} is missing or too long.`);
  return value;
};

const optionalString = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;

const optionalSafeInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const requiredBool = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") throw invalidResponse(`The media-server policy field ${field} is not a boolean.`);
  return value;
};

/** A policy fact a server may or may not report. A missing field keeps the fact unproven rather
 *  than granting it; a present non-boolean is malformed and refused like any other bad field. */
const optionalBool = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw invalidResponse(`The media-server policy field ${field} is not a boolean.`);
  return value;
};

const requiredStringArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.length > MEDIA_SERVER_LIMITS.allowedUsersPerLibrary) {
    throw invalidResponse(`The media-server policy field ${field} is not a bounded string array.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > MEDIA_SERVER_LIMITS.upstreamId) {
      throw invalidResponse(`The media-server policy field ${field} has a malformed entry.`);
    }
    return entry;
  });
};

const ITEM_TYPES = new Map<string, ProviderItemType>([
  ["Movie", "movie"],
  ["MusicVideo", "movie"],
  ["Series", "series"],
  ["Season", "season"],
  ["Episode", "episode"],
  ["Folder", "folder"],
]);

const DIRECTORY_ITEM_TYPE_NAMES: ReadonlyMap<ProviderItemType, string> = new Map([
  ["movie", "Movie"],
  ["series", "Series"],
  ["season", "Season"],
  ["episode", "Episode"],
]);

const SORT_BY: Record<ProviderSort, string> = { name: "SortName", added: "DateCreated", size: "Size" };
const SORT_ORDER: Record<ProviderOrder, string> = { asc: "Ascending", desc: "Descending" };

/** A row's image tag is trusted only in the exact URL-safe alphabet a client URL may carry; a
 *  blank, over-long or foreign-character tag is treated as absent rather than forwarded. */
const lenientArtworkTag = (value: unknown): string | undefined =>
  typeof value === "string" && ARTWORK_TAG.test(value) ? value : undefined;

/** The Primary tag `ImageTags` reports, or undefined for a missing, blank or malformed one. */
function readPrimaryTag(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return lenientArtworkTag((raw as Record<string, unknown>).Primary);
}

/** The Thumb tag `ImageTags` reports, or undefined for a missing, blank or malformed one. */
function readThumbTag(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return lenientArtworkTag((raw as Record<string, unknown>).Thumb);
}

/** The first trustworthy tag from `BackdropImageTags`, else the legacy `ImageTags.Backdrop`. An
 *  empty or malformed list is the metadata's own statement of absence. */
function readBackdropTag(backdropTags: unknown, imageTags: unknown): string | undefined {
  if (Array.isArray(backdropTags)) {
    for (const entry of backdropTags) {
      const tag = lenientArtworkTag(entry);
      if (tag !== undefined) return tag;
    }
  }
  if (typeof imageTags === "object" && imageTags !== null && !Array.isArray(imageTags)) {
    return lenientArtworkTag((imageTags as Record<string, unknown>).Backdrop);
  }
  return undefined;
}

function readProviderIds(raw: unknown): { imdb?: string; tmdb?: string; tvdb?: string } {
  const result: { imdb?: string; tmdb?: string; tvdb?: string } = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return result;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > PROVIDER_ID_MAX) continue;
    const name = key.toLowerCase();
    if (name === "imdb") {
      if (/^tt\d+$/i.test(trimmed)) result.imdb = trimmed.toLowerCase();
    } else if (name === "tmdb" || name === "tvdb") {
      if (/^[1-9][0-9]*$/.test(trimmed)) result[name] = trimmed;
    }
  }
  return result;
}

function providerItem(raw: unknown): ProviderItem {
  const item = asObject(raw, "The media-server item");
  const type = typeof item.Type === "string" ? ITEM_TYPES.get(item.Type) : undefined;
  if (!type) throw invalidResponse("The media-server item has an unsupported type.");
  const result: ProviderItem = {
    id: requiredString(item.Id, MEDIA_SERVER_LIMITS.upstreamId, "item id"),
    name: requiredString(item.Name, MEDIA_SERVER_LIMITS.name, "item name"),
    type,
    providerIds: item.Type === "MusicVideo" ? {} : readProviderIds(item.ProviderIds),
  };
  const parentId = optionalString(item.ParentId, MEDIA_SERVER_LIMITS.upstreamId);
  if (parentId !== undefined) result.parentId = parentId;
  const seriesId = optionalString(item.SeriesId, MEDIA_SERVER_LIMITS.upstreamId);
  if (seriesId !== undefined) result.seriesId = seriesId;
  const seriesName = optionalString(item.SeriesName, MEDIA_SERVER_LIMITS.name);
  if (seriesName !== undefined) result.seriesName = seriesName;
  const season = optionalSafeInt(item.ParentIndexNumber);
  if (season !== undefined) result.season = season;
  const episode = optionalSafeInt(item.IndexNumber);
  if (episode !== undefined) result.episode = episode;
  if (item.IndexNumberEnd !== undefined && item.IndexNumberEnd !== null) {
    const episodeEnd = optionalSafeInt(item.IndexNumberEnd);
    if (episodeEnd === undefined) throw invalidResponse("The media-server episode range is malformed.");
    result.episodeEnd = episodeEnd;
  }
  const durationTicks = optionalSafeInt(item.RunTimeTicks);
  if (durationTicks !== undefined) result.durationTicks = durationTicks;
  const overview = optionalString(item.Overview, 4096);
  if (overview !== undefined) result.overview = overview;
  const year = optionalSafeInt(item.ProductionYear);
  if (year !== undefined && year >= 1800 && year <= 3000) result.year = year;
  if (Array.isArray(item.Genres)) {
    const genres = item.Genres.slice(0, 20).flatMap((value) => {
      const genre = optionalString(value, 128);
      return genre === undefined ? [] : [genre];
    });
    if (genres.length) result.genres = [...new Set(genres)];
  }
  const size = optionalSafeInt(item.Size);
  if (size !== undefined) result.size = size;
  const addedAt = optionalString(item.DateCreated, 64);
  if (addedAt !== undefined && Number.isFinite(Date.parse(addedAt))) result.addedAt = new Date(addedAt).toISOString();
  if (item.ImageTags !== undefined) {
    const tag = readPrimaryTag(item.ImageTags);
    result.hasPrimaryImage = tag !== undefined;
    if (tag !== undefined) result.primaryImageTag = tag;
    const thumb = readThumbTag(item.ImageTags);
    result.hasThumbImage = thumb !== undefined;
    if (thumb !== undefined) result.thumbImageTag = thumb;
  }
  if (item.BackdropImageTags !== undefined) {
    const tag = readBackdropTag(item.BackdropImageTags, undefined);
    result.hasBackdropImage = tag !== undefined;
    if (tag !== undefined) result.backdropImageTag = tag;
  } else if (item.ImageTags !== undefined) {
    const tag = readBackdropTag(undefined, item.ImageTags);
    result.hasBackdropImage = tag !== undefined;
    if (tag !== undefined) result.backdropImageTag = tag;
  }
  const childCount = optionalSafeInt(item.ChildCount);
  if (childCount !== undefined) result.childCount = childCount;
  return result;
}

/** External text subtitles one file version offers. Only a text SubRip track with a bounded
 *  integer index is read; an embedded track, a URL/Path/DeliveryUrl-bearing entry or any other
 *  codec is skipped, so no guessed index or address is ever sealed into a reference. */
function readExternalSubtitles(source: Record<string, unknown>): Array<{ index: number; language?: string; title?: string }> {
  const raw = source.MediaStreams;
  if (!Array.isArray(raw)) return [];
  const subtitles: Array<{ index: number; language?: string; title?: string }> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const stream = entry as Record<string, unknown>;
    if (stream.Type !== "Subtitle" || stream.IsExternal !== true) continue;
    if (typeof stream.Codec !== "string" || !SUBTITLE_TEXT_CODECS.has(stream.Codec.toLowerCase())) continue;
    const index = stream.Index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > SUBTITLE_INDEX_MAX) continue;
    if (subtitles.some((item) => item.index === index)) continue;
    if (subtitles.length >= EXTERNAL_SUBTITLES_MAX) throw invalidResponse("The media-server version offers too many subtitles.");
    const subtitle: { index: number; language?: string; title?: string } = { index };
    const language = optionalString(stream.Language, 64);
    if (language !== undefined) subtitle.language = language;
    const title = optionalString(stream.Title, MEDIA_SERVER_LIMITS.name);
    if (title !== undefined) subtitle.title = title;
    subtitles.push(subtitle);
  }
  return subtitles;
}

type MediaStreamFacts = Pick<ProviderVersion,
  "videoWidth" | "videoHeight" | "audioLanguages" | "embeddedSubtitleLanguages">;

function readMediaStreamFacts(source: Record<string, unknown>): MediaStreamFacts {
  const raw = source.MediaStreams;
  if (!Array.isArray(raw)) return {};
  const audioLanguages: Array<string | undefined> = [];
  const embeddedSubtitleLanguages: Array<string | undefined> = [];
  let videoWidth: number | undefined;
  let videoHeight: number | undefined;
  let foundVideo = false;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const stream = entry as Record<string, unknown>;
    if (!foundVideo && stream.Type === "Video") {
      foundVideo = true;
      if (typeof stream.Width === "number" && Number.isSafeInteger(stream.Width) && stream.Width > 0) {
        videoWidth = stream.Width;
      }
      if (typeof stream.Height === "number" && Number.isSafeInteger(stream.Height) && stream.Height > 0) {
        videoHeight = stream.Height;
      }
      continue;
    }
    if (stream.Type === "Audio") {
      if (audioLanguages.length >= EXTERNAL_SUBTITLES_MAX) {
        throw invalidResponse("The media-server version offers too many audio streams.");
      }
      audioLanguages.push(normalizeLanguage(
        typeof stream.Language === "string" ? stream.Language : undefined,
      ));
      continue;
    }
    if (stream.Type === "Subtitle" && stream.IsExternal !== true) {
      if (embeddedSubtitleLanguages.length >= EXTERNAL_SUBTITLES_MAX) {
        throw invalidResponse("The media-server version offers too many embedded subtitle streams.");
      }
      embeddedSubtitleLanguages.push(normalizeLanguage(
        typeof stream.Language === "string" ? stream.Language : undefined,
      ));
    }
  }
  return {
    ...(videoWidth === undefined ? {} : { videoWidth }),
    ...(videoHeight === undefined ? {} : { videoHeight }),
    ...(audioLanguages.length ? { audioLanguages } : {}),
    ...(embeddedSubtitleLanguages.length ? { embeddedSubtitleLanguages } : {}),
  };
}

/** Standalone music videos use the mixed library layout and the movie playback flow. */
function libraryType(item: Record<string, unknown>): RemoteLibraryType | undefined {
  if (item.Type !== "CollectionFolder") return undefined;
  const collectionType = item.CollectionType;
  if (collectionType === null || collectionType === undefined || collectionType === "") return "mixed";
  if (collectionType === "musicvideos") return "mixed";
  if (collectionType === "movies") return "movie";
  if (collectionType === "tvshows") return "series";
  return undefined;
}

const RESTRICTION_TRUE_FLAGS = ["ForceRemoteSourceTranscoding"];
const RESTRICTION_FALSE_FLAGS = ["EnableRemoteAccess", "EnableAllDevices"];
const RESTRICTION_LISTS = [
  "BlockUnratedItems", "BlockedTags", "AllowedTags", "BlockedChannels", "EnabledChannels",
  "BlockedMediaFolders", "EnabledMediaFolders", "ExcludedTags", "AllowedMediaFolders",
  "EnabledDevices", "IncludeTags", "ExcludedSubFolders", "RestrictedFeatures",
];
/** Record known restriction facts, never a permission. A malformed *known* restriction field
 *  is refused rather than silently read as unrestricted; unknown fields stay unproven. */
function hasAdditionalRestrictions(policy: Record<string, unknown>): boolean {
  for (const field of RESTRICTION_TRUE_FLAGS) {
    const value = policy[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") throw invalidResponse(`The media-server policy field ${field} is not a boolean.`);
    if (value) return true;
  }
  for (const field of RESTRICTION_FALSE_FLAGS) {
    const value = policy[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") throw invalidResponse(`The media-server policy field ${field} is not a boolean.`);
    if (!value) return true;
  }
  for (const field of RESTRICTION_LISTS) {
    const value = policy[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw invalidResponse(`The media-server policy field ${field} is not a string array.`);
    }
    if (value.length > 0) return true;
  }
  const rating = policy.MaxParentalRating;
  if (rating !== undefined && rating !== null) {
    if (typeof rating !== "number" || !Number.isSafeInteger(rating) || rating < 0) {
      throw invalidResponse("The media-server policy field MaxParentalRating is not a non-negative integer.");
    }
    return true;
  }
  for (const [key, value] of Object.entries(policy)) {
    if (/schedule/i.test(key) && Array.isArray(value) && value.length > 0) return true;
  }
  return false;
}

function accountLimits(policy: Record<string, unknown>): { bitrateLimit?: number; streamLimit?: number } {
  const limit = (field: string): number | undefined => {
    const value = policy[field];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw invalidResponse(`The media-server policy field ${field} is not a non-negative integer.`);
    }
    return value === 0 ? undefined : value;
  };
  const bitrateLimit = limit("RemoteClientBitrateLimit");
  const activeSessions = limit("MaxActiveSessions");
  const simultaneousStreams = limit("SimultaneousStreamLimit");
  const streamLimit = [activeSessions, simultaneousStreams].filter((value): value is number => value !== undefined)
    .reduce<number | undefined>((minimum, value) => minimum === undefined || value < minimum ? value : minimum, undefined);
  return {
    ...(bitrateLimit === undefined ? {} : { bitrateLimit }),
    ...(streamLimit === undefined ? {} : { streamLimit }),
  };
}

interface CursorBinding {
  offset: number;
  accountId: string;
  libraryId: string;
  search: string;
}

function encodeCursor(binding: CursorBinding): string {
  return Buffer.from(JSON.stringify({ o: binding.offset, a: binding.accountId, l: binding.libraryId, s: binding.search }), "utf8").toString("base64url");
}

const cursorString = (value: unknown, max: number, allowEmpty: boolean): value is string =>
  typeof value === "string" && (allowEmpty || value.length > 0) && value.length <= max;

/** Strict, canonical decode: bounded base64url, bounded JSON bytes, bounded offset and bounded
 *  binding strings, then a re-encode equality check so no two spellings share one cursor. */
function decodeCursor(cursor: unknown): CursorBinding {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > CURSOR_MAX) throw invalid("The media-server paging cursor is malformed.");
  const json = Buffer.from(cursor, "base64url");
  if (json.length === 0 || json.length > CURSOR_JSON_BYTES_MAX) throw invalid("The media-server paging cursor is malformed.");
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString("utf8")); }
  catch { throw invalid("The media-server paging cursor is malformed."); }
  if (typeof parsed !== "object" || parsed === null) throw invalid("The media-server paging cursor is malformed.");
  const { o, a, l, s } = parsed as Record<string, unknown>;
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 || o > CURSOR_OFFSET_MAX
    || !cursorString(a, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !cursorString(l, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !cursorString(s, SEARCH_MAX, true)) {
    throw invalid("The media-server paging cursor is malformed.");
  }
  const decoded: CursorBinding = { offset: o, accountId: a, libraryId: l, search: s };
  if (encodeCursor(decoded) !== cursor) throw invalid("The media-server paging cursor is not canonical.");
  return decoded;
}

/** A directory cursor binds the whole query identity -- account, parent, mode, type, search and
 *  the sort pair, the season and the initial total -- so a cursor from one listing can never be
 *  replayed against another, and a continuation can report the same stable total. */
interface DirectoryCursorBinding {
  o: number;
  a: string;
  p: string;
  m: string;
  t: string;
  q: string;
  s: string;
  r: string;
  i: string;
  /** The search type set, or "" for an ordinary browse. */
  y: string;
  n: number;
}

const encodeDirectoryCursor = (binding: DirectoryCursorBinding): string =>
  Buffer.from(JSON.stringify(binding), "utf8").toString("base64url");

function decodeDirectoryCursor(cursor: unknown): DirectoryCursorBinding {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > CURSOR_MAX) throw invalid("The media-server paging cursor is malformed.");
  const json = Buffer.from(cursor, "base64url");
  if (json.length === 0 || json.length > CURSOR_JSON_BYTES_MAX) throw invalid("The media-server paging cursor is malformed.");
  let parsed: unknown;
  try { parsed = JSON.parse(json.toString("utf8")); }
  catch { throw invalid("The media-server paging cursor is malformed."); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid("The media-server paging cursor is malformed.");
  const { o, a, p, m, t, q, s, r, i, y, n } = parsed as Record<string, unknown>;
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0 || o > CURSOR_OFFSET_MAX
    || !cursorString(a, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !cursorString(p, MEDIA_SERVER_LIMITS.upstreamId, false)
    || !cursorString(m, 16, false)
    || !cursorString(t, 32, true)
    || !cursorString(q, SEARCH_MAX, true)
    || !cursorString(s, 16, false)
    || !cursorString(r, 16, false)
    || !cursorString(i, 16, true)
    || !cursorString(y, 16, true)
    || typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > CURSOR_OFFSET_MAX) {
    throw invalid("The media-server paging cursor is malformed.");
  }
  const decoded: DirectoryCursorBinding = { o, a, p, m, t, q, s, r, i, y, n };
  if (encodeDirectoryCursor(decoded) !== cursor) throw invalid("The media-server paging cursor is not canonical.");
  return decoded;
}

/** A source is an ordinary safe file only when it is a local file that carries none of the
 *  remote, infinite, opening/closing or live markers. A marker present as anything other than
 *  an explicit `false` (a truthy string, say) is kept out rather than trusted. */
const UNSAFE_FLAGS = ["IsRemote", "IsInfiniteStream", "RequiresOpening", "RequiresClosing"];
function isPlainFile(source: Record<string, unknown>): boolean {
  for (const field of UNSAFE_FLAGS) {
    const value = source[field];
    if (value !== undefined && value !== false) return false;
  }
  return true;
}

const isHlsOrSegmented = (source: Record<string, unknown>): boolean =>
  [source.Protocol, source.Container, source.Path].some((value) => typeof value === "string" && /hls|m3u8/i.test(value));

function playbackInfoSource(raw: unknown): ProviderPlaybackSource | undefined {
  const source = asObject(raw, "The playback media-source entry");
  const id = requiredString(source.Id, MEDIA_SERVER_LIMITS.upstreamId, "media-source id");
  const support = (field: "SupportsDirectPlay" | "SupportsDirectStream" | "SupportsTranscoding"): boolean => {
    const value = source[field];
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw invalidResponse(`The media-server ${field} field is not a boolean.`);
    return value;
  };
  const supportsDirectPlay = support("SupportsDirectPlay");
  const supportsDirectStream = support("SupportsDirectStream");
  const supportsTranscoding = support("SupportsTranscoding");
  let bitrate: number | undefined;
  if (source.Bitrate !== undefined) {
    if (typeof source.Bitrate !== "number" || !Number.isSafeInteger(source.Bitrate) || source.Bitrate < 0) {
      throw invalidResponse("The media-server media-source bitrate is malformed.");
    }
    if (source.Bitrate > 0) bitrate = source.Bitrate;
  }
  if (source.Protocol !== "File" || isHlsOrSegmented(source) || !isPlainFile(source)) return undefined;
  if (source.LiveStreamId !== undefined && source.LiveStreamId !== null && source.LiveStreamId !== "") return undefined;
  return {
    id,
    ...(bitrate === undefined ? {} : { bitrate }),
    supportsDirectPlay,
    supportsDirectStream,
    supportsTranscoding,
  };
}

export function createMediaServerProvider(kind: MediaServerKind, transport: MediaServerTransport): MediaServerProvider {
  if (!MEDIA_SERVER_KINDS.includes(kind)) throw invalid("The media-server provider kind is not supported.");

  async function verifyIdentity(signal?: AbortSignal): Promise<{ serverId: string; version: string }> {
    const info = asObject(await transport.requestJson("info", {}, undefined, signal), "The media-server identity");
    return {
      serverId: requiredString(info.Id, MEDIA_SERVER_LIMITS.upstreamId, "server id"),
      version: requiredString(info.Version, 128, "version"),
    };
  }

  async function authenticate(username: string, password: string, signal?: AbortSignal): Promise<{ serverId: string; accountId: string; token: string }> {
    if (typeof username !== "string" || typeof password !== "string") throw invalid("The media-server credentials are malformed.");
    const identity = await verifyIdentity(signal);
    const result = asObject(await transport.requestJson("login", { username, password }, undefined, signal), "The authentication response");
    const user = asObject(result.User, "The authentication response user");
    const accountId = requiredString(user.Id, MEDIA_SERVER_LIMITS.upstreamId, "account id");
    if (user.ServerId !== undefined && requiredString(user.ServerId, MEDIA_SERVER_LIMITS.upstreamId, "server id") !== identity.serverId) {
      throw invalidResponse("The server identity changed during authentication.");
    }
    if (typeof result.AccessToken !== "string") throw invalidResponse("The authentication response has no token.");
    return { serverId: identity.serverId, accountId, token: validateMediaServerToken(result.AccessToken) };
  }

  async function logout(token: string, signal?: AbortSignal): Promise<void> {
    await transport.requestJson("logout", {}, token, signal);
  }

  async function currentAccount(token: string, accountId: string, signal?: AbortSignal): Promise<{ accountId: string; policy: RemoteAccountPolicy }> {
    const user = asObject(await transport.requestJson("user", { userId: accountId }, token, signal), "The account response");
    if (user.Id !== accountId) throw invalidResponse("The account response is for another user.");
    const policy = asObject(user.Policy, "The account policy");
    const contentDownloading = optionalBool(policy.EnableContentDownloading, "EnableContentDownloading");
    const limits = accountLimits(policy);
    return {
      accountId,
      policy: {
        disabled: requiredBool(policy.IsDisabled, "IsDisabled"),
        mediaPlayback: requiredBool(policy.EnableMediaPlayback, "EnableMediaPlayback"),
        ...(contentDownloading === undefined ? {} : { contentDownloading }),
        allFolders: requiredBool(policy.EnableAllFolders, "EnableAllFolders"),
        folderIds: requiredStringArray(policy.EnabledFolders, "EnabledFolders"),
        hasAdditionalRestrictions: hasAdditionalRestrictions(policy),
        ...limits,
      },
    };
  }

  async function listLibraries(token: string, accountId: string, signal?: AbortSignal): Promise<ProviderLibrary[]> {
    const response = asObject(await transport.requestJson("views", { userId: accountId }, token, signal), "The library view response");
    if (!Array.isArray(response.Items)) throw invalidResponse("The library view response has no item array.");
    if (response.Items.length > LIBRARIES_MAX) throw invalidResponse("The library view response has too many entries.");
    const libraries: ProviderLibrary[] = [];
    for (const raw of response.Items) {
      const item = asObject(raw, "The library view entry");
      const type = libraryType(item);
      if (!type) continue;
      const library: ProviderLibrary = {
        id: requiredString(item.Id, MEDIA_SERVER_LIMITS.upstreamId, "library id"),
        name: requiredString(item.Name, MEDIA_SERVER_LIMITS.name, "library name"),
        type,
      };
      const tag = readPrimaryTag(item.ImageTags);
      if (tag !== undefined) library.primaryImageTag = tag;
      libraries.push(library);
    }
    return libraries;
  }

  async function pageItems(
    token: string,
    accountId: string,
    libraryId: string,
    options: { cursor?: string; limit?: number; search?: string } = {},
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("The media-server page limit is out of range.");
    const search = options.search;
    if (search !== undefined && (typeof search !== "string" || search.length === 0 || search.length > SEARCH_MAX)) throw invalid("The media-server search term is not allowed.");
    let offset = 0;
    if (options.cursor !== undefined) {
      const decoded = decodeCursor(options.cursor);
      if (decoded.accountId !== accountId || decoded.libraryId !== libraryId || decoded.search !== (search ?? "")) {
        throw invalid("The media-server paging cursor does not belong to this query.");
      }
      offset = decoded.offset;
    }
    const args = {
      userId: accountId,
      parentId: libraryId,
      includeItemTypes: "Movie,Series,Season,Episode,MusicVideo",
      startIndex: offset,
      limit,
      ...(search !== undefined ? { searchTerm: search } : {}),
    };
    const response = asObject(await transport.requestJson("items", args, token, signal), "The item page response");
    if (!Array.isArray(response.Items)) throw invalidResponse("The item page response has no item array.");
    const total = response.TotalRecordCount;
    if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > CURSOR_OFFSET_MAX) throw invalidResponse("The item page response has no supported total.");
    const items = response.Items.map((raw) => providerItem(raw));
    if (items.length > limit) throw invalidResponse("The item page returned more items than requested.");
    if (offset + items.length > total || (items.length === 0 && offset < total)) {
      throw invalidResponse("The item page is inconsistent with its total.");
    }
    const page: ProviderPage = { items, total };
    if (items.length > 0 && offset + items.length < total) {
      page.cursor = encodeCursor({ offset: offset + items.length, accountId, libraryId, search: search ?? "" });
    }
    return page;
  }

  /** One page of a native browse: a folder's children (folders mode) or a library's titles
   *  (titles mode). It reads exactly one provider page and never walks a cursor itself. */
  async function pageDirectory(
    token: string,
    accountId: string,
    parentId: string,
    options: ProviderDirectoryOptions,
    signal?: AbortSignal,
  ): Promise<ProviderPage> {
    if (typeof parentId !== "string" || parentId.length === 0 || parentId.length > MEDIA_SERVER_LIMITS.upstreamId) {
      throw invalid("The media-server parent id is missing or too long.");
    }
    const mode = options?.mode;
    if (mode !== "folders" && mode !== "titles") throw invalid("The media-server browse mode is not supported.");
    const limit = options.limit ?? DIRECTORY_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("The media-server page limit is out of range.");
    const search = options.search;
    if (search !== undefined && (typeof search !== "string" || search.length === 0 || search.length > SEARCH_MAX)) {
      throw invalid("The media-server search term is not allowed.");
    }
    const type = options.type;
    if (type !== undefined && !DIRECTORY_ITEM_TYPE_NAMES.has(type)) throw invalid("The media-server item type is not supported.");
    const searchTypes = options.searchTypes;
    if (
      searchTypes !== undefined
      && searchTypes !== "movie"
      && searchTypes !== "series"
      && searchTypes !== "all"
    ) {
      throw invalid("The media-server search type set is not supported.");
    }
    if (searchTypes !== undefined && mode !== "titles") {
      throw invalid("A media-server search must use titles mode.");
    }
    if (searchTypes !== undefined && type !== undefined) {
      throw invalid("A media-server search cannot also name one item type.");
    }
    const sort: ProviderSort = searchTypes === undefined ? (options.sort ?? "name") : "name";
    if (!PROVIDER_SORTS.includes(sort)) throw invalid("The media-server sort is not supported.");
    const order: ProviderOrder = searchTypes === undefined ? (options.order ?? "asc") : "asc";
    if (!PROVIDER_ORDERS.includes(order)) throw invalid("The media-server order is not supported.");
    const season = options.season;
    if (season !== undefined && (typeof season !== "number" || !Number.isSafeInteger(season) || season < 0 || season > SEASON_MAX)) {
      throw invalid("The media-server season is out of range.");
    }
    const seasonKey = season === undefined ? "" : String(season);
    // The first page carries the count; a continuation reuses the total sealed into the cursor
    // instead, so a server that omits `TotalRecordCount` when the count is off cannot make the
    // public total shrink between pages.
    const continuation = options.cursor !== undefined;
    let offset = 0;
    let storedTotal = 0;
    if (continuation) {
      const decoded = decodeDirectoryCursor(options.cursor);
      if (decoded.a !== accountId || decoded.p !== parentId || decoded.m !== mode || decoded.t !== (type ?? "")
        || decoded.q !== (search ?? "") || decoded.s !== sort || decoded.r !== order || decoded.i !== seasonKey
        || decoded.y !== (searchTypes ?? "")) {
        throw invalid("The media-server paging cursor does not belong to this query.");
      }
      offset = decoded.o;
      storedTotal = decoded.n;
    }
    const filteredTypes = type === "movie" ? "Movie,MusicVideo" : type === "series" && mode === "folders"
      ? "Series,Season,Episode" : type === undefined ? undefined : DIRECTORY_ITEM_TYPE_NAMES.get(type);
    // A music video is listed as a film the way title browse lists it: a library of clips that
    // carry no film metadata must still answer a search for their names.
    const includeItemTypes = searchTypes === "movie"
      ? "Movie,MusicVideo"
      : searchTypes === "series"
        ? "Series,Episode"
        : searchTypes === "all"
          ? "Movie,MusicVideo,Series,Episode,Folder"
          : filteredTypes === undefined
            ? mode === "folders" ? DIRECTORY_FOLDER_TYPES : DIRECTORY_TITLE_TYPES
            : mode === "folders" ? `Folder,${filteredTypes}` : filteredTypes;
    const args = {
      userId: accountId,
      parentId,
      includeItemTypes,
      recursive: mode === "titles",
      sortBy: type === "episode" && sort === "name" ? "ParentIndexNumber,IndexNumber,SortName" : SORT_BY[sort],
      sortOrder: SORT_ORDER[order],
      startIndex: offset,
      limit,
      enableTotalRecordCount: !continuation,
      ...(season !== undefined ? { parentIndexNumber: season } : {}),
      ...(search !== undefined ? { searchTerm: search } : {}),
    };
    const response = asObject(await transport.requestJson("directory", args, token, signal), "The browse response");
    if (!Array.isArray(response.Items)) throw invalidResponse("The browse response has no item array.");
    let total: number;
    if (continuation) {
      total = storedTotal;
    } else {
      total = response.TotalRecordCount as number;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0 || total > CURSOR_OFFSET_MAX) {
        throw invalidResponse("The browse response has no supported total.");
      }
    }
    const items = response.Items.map((raw) => providerItem(raw));
    if (items.length > limit) throw invalidResponse("The browse page returned more items than requested.");
    if (offset + items.length > total || (items.length === 0 && offset < total)) {
      throw invalidResponse("The browse page is inconsistent with its total.");
    }
    const page: ProviderPage = { items, total };
    if (items.length > 0 && offset + items.length < total) {
      page.cursor = encodeDirectoryCursor({ o: offset + items.length, a: accountId, p: parentId, m: mode, t: type ?? "", q: search ?? "", s: sort, r: order, i: seasonKey, y: searchTypes ?? "", n: total });
    }
    return page;
  }

  async function detail(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderItem> {
    const item = providerItem(await transport.requestJson("detail", { userId: accountId, itemId }, token, signal));
    if (item.id !== itemId) throw invalidResponse("The media-server detail response is for another item.");
    return item;
  }

  /** The catalogue ids a match may use, most specific first, and the shape each one must have
   *  before it can name a provider filter. Anything else is skipped rather than sent upstream. */
  const MATCH_ID_PATTERNS: ReadonlyArray<readonly ["imdb" | "tmdb" | "tvdb", RegExp]> = [
    ["imdb", /^tt[0-9]{1,12}$/],
    ["tmdb", /^[1-9][0-9]{0,11}$/],
    ["tvdb", /^[1-9][0-9]{0,11}$/],
  ];

  /** One bounded list query scoped to the library, then a local exact-id check. Emby answers an
   *  exact `AnyProviderIdEquals` filter. Jellyfin 12.2 ignores that parameter, so it answers a
   *  documented `Has<Name>Id` page narrowed by the caller's title; a legacy caller that omits the
   *  title gets that same single page, which the local check narrows but never treats as
   *  exhaustive. Either way the returned rows are the only candidates and each is verified here. */
  async function findByProviderIds(
    token: string,
    accountId: string,
    libraryId: string,
    ids: { imdb?: string; tmdb?: string; tvdb?: string },
    type: "movie" | "series",
    nameHint?: string,
    signal?: AbortSignal,
  ): Promise<ProviderItem[]> {
    if (type !== "movie" && type !== "series") throw invalid("The media-server match type is not supported.");
    let providerName: "imdb" | "tmdb" | "tvdb" | undefined;
    let providerId: string | undefined;
    for (const [name, pattern] of MATCH_ID_PATTERNS) {
      const value = ids?.[name];
      if (typeof value !== "string" || !pattern.test(value)) continue;
      providerName = name;
      providerId = name === "imdb" ? value.toLowerCase() : value;
      break;
    }
    if (providerName === undefined || providerId === undefined) return [];
    if (nameHint !== undefined && (typeof nameHint !== "string" || nameHint.length === 0 || nameHint.length > SEARCH_MAX)) {
      throw invalid("The media-server match name is not allowed.");
    }
    const response = asObject(await transport.requestJson("match", {
      userId: accountId,
      parentId: libraryId,
      provider: kind,
      providerName,
      providerId,
      includeItemTypes: type === "movie" ? "Movie" : "Series",
      limit: MATCH_LIMIT,
      ...(nameHint !== undefined ? { searchTerm: nameHint } : {}),
    }, token, signal), "The match response");
    if (!Array.isArray(response.Items)) throw invalidResponse("The match response has no item array.");
    if (response.Items.length > MATCH_LIMIT) throw invalidResponse("The match response returned too many items.");
    const matched = providerName;
    const wanted = providerId;
    return response.Items.map((raw) => providerItem(raw)).filter((item) => item.providerIds[matched] === wanted);
  }

  async function ancestors(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<string[]> {
    const response = await transport.requestJson("ancestors", { itemId, userId: accountId }, token, signal);
    if (!Array.isArray(response)) throw invalidResponse("The ancestor response is not an array.");
    if (response.length > ANCESTORS_MAX) throw invalidResponse("The ancestor response has too many entries.");
    return response.map((raw) => requiredString(asObject(raw, "The ancestor entry").Id, MEDIA_SERVER_LIMITS.upstreamId, "item id"));
  }

  /** Emby names a version by the file name with its folder's name cut off the front, so
   *  `Avatar/Avatar.2009.720p.mkv` arrives as `.2009.720p`. Such a stump gets the whole file name back. */
  function versionName(name: string | undefined, sourcePath: unknown): string | undefined {
    if (name === undefined || /^[\p{L}\p{N}]/u.test(name) || typeof sourcePath !== "string") return name;
    const file = sourcePath.split(/[\\/]/).pop() ?? "";
    const dot = file.lastIndexOf(".");
    const stem = dot > 0 ? file.slice(0, dot) : file;
    return stem.length > name.length && stem.endsWith(name) && stem.length <= MEDIA_SERVER_LIMITS.name ? stem : name;
  }

  async function versions(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderVersion[]> {
    const response = asObject(await transport.requestJson("versions", { itemId, userId: accountId }, token, signal), "The version response");
    if (!Array.isArray(response.MediaSources)) throw invalidResponse("The version response has no media-source array.");
    if (response.MediaSources.length > VERSIONS_MAX) throw invalidResponse("The version response has too many entries.");
    const versions: ProviderVersion[] = [];
    for (const raw of response.MediaSources) {
      const source = asObject(raw, "The media-source entry");
      if (source.Protocol !== "File") continue;
      if (isHlsOrSegmented(source)) continue;
      if (!isPlainFile(source)) continue;
      if (source.LiveStreamId !== undefined && source.LiveStreamId !== null && source.LiveStreamId !== "") continue;
      const version: ProviderVersion = { id: requiredString(source.Id, MEDIA_SERVER_LIMITS.upstreamId, "version id") };
      const name = versionName(optionalString(source.Name, MEDIA_SERVER_LIMITS.name), source.Path);
      if (name !== undefined) version.name = name;
      const container = optionalString(source.Container, 64);
      if (container !== undefined) version.container = container;
      if (containerExtension(container) === undefined) {
        const extension = nameExtension(source.Path);
        if (extension) version.container = extension.slice(1);
      }
      const size = optionalSafeInt(source.Size);
      if (size !== undefined) version.size = size;
      const durationTicks = optionalSafeInt(source.RunTimeTicks);
      if (durationTicks !== undefined) version.durationTicks = durationTicks;
      const bitrate = optionalSafeInt(source.Bitrate);
      if (bitrate !== undefined && bitrate > 0) version.bitrate = bitrate;
      Object.assign(version, readMediaStreamFacts(source));
      const externalSubtitles = readExternalSubtitles(source);
      if (externalSubtitles.length) version.externalSubtitles = externalSubtitles;
      versions.push(version);
    }
    return versions;
  }

  async function playbackInfo(
    token: string,
    accountId: string,
    itemId: string,
    options: {
      mediaSourceId?: string;
      maxStreamingBitrate?: number;
      isPlayback: boolean;
    },
    signal?: AbortSignal,
  ): Promise<ProviderPlaybackInfo> {
    const response = asObject(await transport.requestJson("playbackInfo", {
      userId: accountId,
      itemId,
      ...(options.mediaSourceId === undefined ? {} : { mediaSourceId: options.mediaSourceId }),
      ...(options.maxStreamingBitrate === undefined ? {} : { maxStreamingBitrate: options.maxStreamingBitrate }),
      isPlayback: options.isPlayback,
    }, token, signal), "The playback-info response");
    const rawError = response.ErrorCode;
    if (rawError !== undefined) {
      if (typeof rawError !== "string" || !PLAYBACK_ERROR_CODES.has(rawError as NonNullable<ProviderPlaybackInfo["errorCode"]>)) {
        throw invalidResponse("The media-server playback error code is not supported.");
      }
      const errorCode = rawError as NonNullable<ProviderPlaybackInfo["errorCode"]>;
      if (errorCode === "RateLimitExceeded") transport.noteRateLimit();
      return { mediaSources: [], errorCode };
    }
    let playSessionId: string | undefined;
    if (response.PlaySessionId !== undefined) {
      if (typeof response.PlaySessionId !== "string" || !PLAY_SESSION_ID.test(response.PlaySessionId)) {
        throw invalidResponse("The media-server playback session id is malformed.");
      }
      playSessionId = response.PlaySessionId;
    }
    let mediaSources: ProviderPlaybackSource[] = [];
    if (response.MediaSources !== undefined) {
      if (!Array.isArray(response.MediaSources)) throw invalidResponse("The playback-info response has no media-source array.");
      if (response.MediaSources.length > VERSIONS_MAX) throw invalidResponse("The playback-info response has too many media sources.");
      mediaSources = response.MediaSources.flatMap((source) => {
        const parsed = playbackInfoSource(source);
        return parsed === undefined ? [] : [parsed];
      });
    }
    return {
      mediaSources,
      ...(playSessionId === undefined ? {} : { playSessionId }),
    };
  }

  async function reportPlayback(token: string, itemId: string, report: ProviderPlaybackReport, signal?: AbortSignal): Promise<void> {
    if (report.kind === "playing") {
      await transport.requestJson("playing", {
        itemId,
        mediaSourceId: report.mediaSourceId,
        playSessionId: report.playSessionId,
        positionTicks: report.positionTicks,
        isPaused: report.isPaused,
      }, token, signal);
      return;
    }
    if (report.kind === "progress") {
      await transport.requestJson("playingProgress", {
        itemId,
        mediaSourceId: report.mediaSourceId,
        playSessionId: report.playSessionId,
        positionTicks: report.positionTicks,
        isPaused: report.isPaused,
        ...(report.eventName === undefined ? {} : { eventName: report.eventName }),
      }, token, signal);
      return;
    }
    await transport.requestJson("playingStopped", {
      itemId,
      mediaSourceId: report.mediaSourceId,
      playSessionId: report.playSessionId,
      positionTicks: report.positionTicks,
    }, token, signal);
  }

  return { verifyIdentity, authenticate, logout, currentAccount, listLibraries, pageItems, pageDirectory, detail, findByProviderIds, ancestors, versions, playbackInfo, reportPlayback };
}
