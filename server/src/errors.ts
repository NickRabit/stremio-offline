/** A failure the interface will put in front of someone. The key lets the client render
 *  it in the language that person chose; the English text is the fallback for any client
 *  that does not know the key -- an older build, or a message added after it shipped.
 *  Variables fill the placeholders a catalogue entry leaves in that text, and are only
 *  worth carrying where the question cannot be phrased without them.
 *  Failures that only ever reach the log carry no key and stay plain English. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly messageKey: string,
    readonly status?: number,
    readonly vars?: Record<string, string | number>,
  ) { super(message); }
}

export const messageKeyOf = (error: unknown): string | undefined =>
  typeof (error as { messageKey?: unknown })?.messageKey === "string" ? (error as { messageKey: string }).messageKey : undefined;

/** Where a failure came from, for a client that wants to group or route it by area rather
 *  than by the catalogue key alone. */
export type ErrorCategory =
  | "source"
  | "network"
  | "storage"
  | "library"
  | "playback"
  | "transcode"
  | "addon"
  | "authentication"
  | "configuration"
  | "internal";

/** What a client should do with a failure. `automatic` means the server is already retrying;
 *  `manual` means trying again later may work; `action` means the person has to change
 *  something first; `permanent` means this exact request will never succeed. */
export type RetryDisposition = "automatic" | "manual" | "action" | "permanent";

export interface ErrorClassification {
  category: ErrorCategory;
  retry: RetryDisposition;
}

/** The single keyed table: a catalogue key carries the category and the retry guidance that
 *  belongs to it. Storage, download and playback keys come first, then the account and
 *  permission keys, then a handful of addon keys so every category has a home. */
const TABLE: Record<string, ErrorClassification> = {
  // Download source and queue.
  "err.noMatchingSource": { category: "source", retry: "manual" },
  "err.downloadNeedsHttp": { category: "source", retry: "action" },
  "err.sourceQueued": { category: "source", retry: "permanent" },
  "err.torrentQueued": { category: "source", retry: "permanent" },
  "err.sourceDownloaded": { category: "library", retry: "permanent" },
  "err.jobNoInfoHash": { category: "source", retry: "permanent" },
  "err.retryingAfterDrop": { category: "network", retry: "automatic" },
  "err.sourceFailedTryingNext": { category: "source", retry: "automatic" },
  "err.debridTimeout": { category: "network", retry: "manual" },
  "err.debridWrongEpisode": { category: "source", retry: "manual" },
  "err.debridNotConfigured": { category: "configuration", retry: "action" },
  "err.debridTokenMissing": { category: "configuration", retry: "action" },

  // Queue file and disk.
  "err.noSpace": { category: "storage", retry: "automatic" },
  "err.noFreeName": { category: "storage", retry: "action" },
  "err.queueUnreadable": { category: "storage", retry: "manual" },
  "err.queueNotSaved": { category: "storage", retry: "manual" },

  // Download destination and requested state.
  "err.libraryNotWritable": { category: "library", retry: "action" },
  "err.chosenLibraryGone": { category: "library", retry: "action" },
  "err.noLibraryForMovies": { category: "library", retry: "action" },
  "err.noLibraryForSeries": { category: "library", retry: "action" },
  "err.cannotPauseCompleted": { category: "configuration", retry: "permanent" },
  "err.cannotResume": { category: "configuration", retry: "action" },
  "err.retryOnlyFailed": { category: "configuration", retry: "action" },
  "err.itemNotFound": { category: "configuration", retry: "permanent" },

  // Download route preconditions.
  "err.invalidDownloadTarget": { category: "configuration", retry: "action" },
  "err.missingDownloadSources": { category: "configuration", retry: "action" },
  "err.missingAudioLanguage": { category: "configuration", retry: "action" },
  "err.missingSubtitleLanguage": { category: "configuration", retry: "action" },
  "err.missingEpisodes": { category: "configuration", retry: "action" },
  "err.tooManyEpisodes": { category: "configuration", retry: "action" },
  "err.libraryNotFound": { category: "library", retry: "action" },
  "err.targetFolderMissing": { category: "library", retry: "action" },

  // Library file operations and their state file.
  "err.invalidPath": { category: "library", retry: "action" },
  "err.pathMissing": { category: "library", retry: "action" },
  "err.nameTaken": { category: "library", retry: "action" },
  "err.libraryHoldsAnother": { category: "library", retry: "action" },
  "err.libraryTypeMismatch": { category: "library", retry: "action" },
  "err.targetMissing": { category: "library", retry: "action" },
  "err.sameFolder": { category: "library", retry: "permanent" },
  "err.moveIntoItself": { category: "library", retry: "permanent" },
  "err.libraryOpsUnreadable": { category: "storage", retry: "manual" },
  "err.followsUnreadable": { category: "storage", retry: "manual" },

  // Playback and conversion.
  "err.noPlayableAddress": { category: "source", retry: "action" },
  "err.playbackSessionGone": { category: "playback", retry: "permanent" },
  "err.conversionFailed": { category: "transcode", retry: "manual" },

  // Account, session and permission gates.
  "err.restricted": { category: "authentication", retry: "action" },
  "err.notAllowed": { category: "authentication", retry: "action" },
  "err.mustChangePassword": { category: "authentication", retry: "action" },
  "err.downloadLibraryNotAllowed": { category: "authentication", retry: "action" },
  "err.badCredentials": { category: "authentication", retry: "action" },
  "err.notSignedIn": { category: "authentication", retry: "action" },
  "err.tooManyAttempts": { category: "authentication", retry: "manual" },
  "err.wrongCurrentPassword": { category: "authentication", retry: "action" },
  "err.unknownUser": { category: "authentication", retry: "action" },
  "err.noAccount": { category: "configuration", retry: "action" },
  "err.usernameTaken": { category: "configuration", retry: "action" },
  "err.setupDone": { category: "configuration", retry: "permanent" },
  "err.setupLocalOnly": { category: "configuration", retry: "action" },

  // Addons.
  "err.addonNotFound": { category: "addon", retry: "action" },
  "err.addonNotJson": { category: "addon", retry: "action" },
  "err.privateAddon": { category: "addon", retry: "action" },
  "err.manifestIncomplete": { category: "addon", retry: "action" },
  "err.manifestExists": { category: "addon", retry: "permanent" },
  "err.essentialAddon": { category: "addon", retry: "permanent" },

  // A source host the breaker is holding back: it retries on its own once the cooldown ends.
  "err.hostUnavailable": { category: "network", retry: "manual" },
};

/** `ResourceError` has no catalogue key, so its stable code is the table's second key. */
const RESOURCE_CODES: Record<string, ErrorClassification> = {
  AUTH_REQUIRED: { category: "authentication", retry: "action" },
  RESOURCE_NOT_FOUND: { category: "source", retry: "permanent" },
  RESOURCE_EXPIRED: { category: "source", retry: "permanent" },
  RESOURCE_LIMIT: { category: "source", retry: "manual" },
  UNSAFE_SOURCE_INPUT: { category: "configuration", retry: "action" },
  INVALID_SUBTITLES: { category: "configuration", retry: "action" },
};

/** An `AppError` is a sentence the server wrote for the interface: an unlisted one is almost
 *  always a precondition the person has to resolve, so `configuration`/`action` is the least
 *  wrong guess. Unknown exceptions are a bug, not a state the person can change. */
const APP_ERROR_FALLBACK: ErrorClassification = { category: "configuration", retry: "action" };
const UNKNOWN_FALLBACK: ErrorClassification = { category: "internal", retry: "manual" };

/** `ResourceError` carries a numeric status beside its code; a plain `Error` from the runtime
 *  carries a string code (ENOENT, ECONNRESET) but no status, so the two do not collide. */
const isResourceError = (error: unknown): boolean => {
  const shaped = error as { code?: unknown; status?: unknown } | null | undefined;
  return typeof shaped?.code === "string" && typeof shaped.status === "number";
};

/** A Real-Debrid answer, by its status: the account or token needs the person, a busy or
 *  silent service is retried, anything else is the source's own refusal. */
const debridClass = (error: { status?: unknown }): ErrorClassification => {
  const status = typeof error.status === "number" ? error.status : 400;
  if (status === 401 || status === 403) return { category: "configuration", retry: "action" };
  if (status === 408 || status === 429 || status === 503 || status === 509) return { category: "network", retry: "automatic" };
  return { category: "source", retry: "manual" };
};

export const classifyError = (error: unknown): ErrorClassification => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  // Own properties only: a key or code that names something on Object.prototype is not a class.
  if (typeof code === "string" && Object.hasOwn(RESOURCE_CODES, code)) return RESOURCE_CODES[code]!;
  const key = messageKeyOf(error);
  if (key !== undefined && Object.hasOwn(TABLE, key)) return TABLE[key]!;
  if ((error as { name?: unknown } | null | undefined)?.name === "DebridError") return debridClass(error as { status?: unknown });
  return error instanceof AppError ? APP_ERROR_FALLBACK : UNKNOWN_FALLBACK;
};

/** Whether a failure is a sentence the server wrote on purpose -- an AppError, a media resource
 *  refusal, a Real-Debrid answer, or anything carrying a catalogue key -- rather than an
 *  exception nobody anticipated. Only the latter gets a reference to quote. */
export const explainedError = (error: unknown): boolean => {
  if (error instanceof AppError || messageKeyOf(error) !== undefined) return true;
  if ((error as { name?: unknown } | null | undefined)?.name === "DebridError") return true;
  // A media resource refusal by its own codes, not by its shape: express' body errors carry a
  // string code beside a numeric status too, and nobody wrote a sentence for those.
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return isResourceError(error) && typeof code === "string" && Object.hasOwn(RESOURCE_CODES, code);
};
