import {
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
  allFolders: boolean;
  folderIds: string[];
  hasAdditionalRestrictions: boolean;
}

export interface ProviderLibrary {
  id: string;
  name: string;
  type: RemoteLibraryType;
}

export type ProviderItemType = "movie" | "series" | "season" | "episode";

export interface ProviderItem {
  id: string;
  name: string;
  type: ProviderItemType;
  parentId?: string;
  seriesId?: string;
  season?: number;
  episode?: number;
  episodeEnd?: number;
  providerIds: { imdb?: string; tmdb?: string; tvdb?: string };
  durationTicks?: number;
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
  /** External text subtitles the provider offers for this exact file version. */
  externalSubtitles?: Array<{ index: number; language?: string; title?: string }>;
}

export interface MediaServerProvider {
  verifyIdentity(signal?: AbortSignal): Promise<{ serverId: string; version: string }>;
  authenticate(username: string, password: string, signal?: AbortSignal): Promise<{ serverId: string; accountId: string; token: string }>;
  currentAccount(token: string, accountId: string, signal?: AbortSignal): Promise<{ accountId: string; policy: RemoteAccountPolicy }>;
  listLibraries(token: string, accountId: string, signal?: AbortSignal): Promise<ProviderLibrary[]>;
  pageItems(token: string, accountId: string, libraryId: string, options?: { cursor?: string; limit?: number; search?: string }, signal?: AbortSignal): Promise<ProviderPage>;
  detail(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderItem>;
  ancestors(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<string[]>;
  versions(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderVersion[]>;
}

const LIBRARIES_MAX = MEDIA_SERVER_LIMITS.libraries;
const ANCESTORS_MAX = 128;
const VERSIONS_MAX = 200;
const EXTERNAL_SUBTITLES_MAX = 64;
const SUBTITLE_INDEX_MAX = 1023;
const SUBTITLE_TEXT_CODECS = new Set(["subrip", "srt"]);
const PROVIDER_ID_MAX = 512;
const CURSOR_MAX = 8192;
const CURSOR_JSON_BYTES_MAX = 6144;
const CURSOR_OFFSET_MAX = 1_000_000_000;
const SEARCH_MAX = 256;

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
]);

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
const RESTRICTION_LIMITS = ["RemoteClientBitrateLimit", "SimultaneousStreamLimit", "MaxActiveSessions"];

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
  for (const field of RESTRICTION_LIMITS) {
    const value = policy[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw invalidResponse(`The media-server policy field ${field} is not a non-negative integer.`);
    }
    if (value !== 0) return true;
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

  async function currentAccount(token: string, accountId: string, signal?: AbortSignal): Promise<{ accountId: string; policy: RemoteAccountPolicy }> {
    const user = asObject(await transport.requestJson("user", { userId: accountId }, token, signal), "The account response");
    if (user.Id !== accountId) throw invalidResponse("The account response is for another user.");
    const policy = asObject(user.Policy, "The account policy");
    return {
      accountId,
      policy: {
        disabled: requiredBool(policy.IsDisabled, "IsDisabled"),
        mediaPlayback: requiredBool(policy.EnableMediaPlayback, "EnableMediaPlayback"),
        allFolders: requiredBool(policy.EnableAllFolders, "EnableAllFolders"),
        folderIds: requiredStringArray(policy.EnabledFolders, "EnabledFolders"),
        hasAdditionalRestrictions: hasAdditionalRestrictions(policy),
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
      libraries.push({
        id: requiredString(item.Id, MEDIA_SERVER_LIMITS.upstreamId, "library id"),
        name: requiredString(item.Name, MEDIA_SERVER_LIMITS.name, "library name"),
        type,
      });
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

  async function detail(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<ProviderItem> {
    const item = providerItem(await transport.requestJson("detail", { userId: accountId, itemId }, token, signal));
    if (item.id !== itemId) throw invalidResponse("The media-server detail response is for another item.");
    return item;
  }

  async function ancestors(token: string, accountId: string, itemId: string, signal?: AbortSignal): Promise<string[]> {
    const response = await transport.requestJson("ancestors", { itemId, userId: accountId }, token, signal);
    if (!Array.isArray(response)) throw invalidResponse("The ancestor response is not an array.");
    if (response.length > ANCESTORS_MAX) throw invalidResponse("The ancestor response has too many entries.");
    return response.map((raw) => requiredString(asObject(raw, "The ancestor entry").Id, MEDIA_SERVER_LIMITS.upstreamId, "item id"));
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
      const name = optionalString(source.Name, MEDIA_SERVER_LIMITS.name);
      if (name !== undefined) version.name = name;
      const container = optionalString(source.Container, 64);
      if (container !== undefined) version.container = container;
      const size = optionalSafeInt(source.Size);
      if (size !== undefined) version.size = size;
      const durationTicks = optionalSafeInt(source.RunTimeTicks);
      if (durationTicks !== undefined) version.durationTicks = durationTicks;
      const externalSubtitles = readExternalSubtitles(source);
      if (externalSubtitles.length) version.externalSubtitles = externalSubtitles;
      versions.push(version);
    }
    return versions;
  }

  return { verifyIdentity, authenticate, currentAccount, listLibraries, pageItems, detail, ancestors, versions };
}
