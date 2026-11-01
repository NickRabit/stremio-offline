import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AudioCodec, AudioFacts } from "./api-types.js";
import { renameWithRetry } from "./fs-retry.js";
import { log } from "./logger.js";
import type { MediaInfo } from "./probe.js";

/** A library file as the walk saw it. The size and the modification time are what tell a
 *  remembered reading from one the file has since outgrown. */
export interface LibraryFileStamp { key: string; size: number; modified: string }

interface Entry {
  size: number;
  modified: string;
  /** `null` when ffprobe could not read the file. */
  info: MediaInfo | null;
  at: number;
}

export interface LibraryFileFacts {
  /** What each file holds. Readings already in hand come back at once; the rest are started
   *  and waited for until `waitMs` runs out, then keep going so the next listing has them. */
  read(files: readonly LibraryFileStamp[], opts?: { waitMs?: number }): Promise<Map<string, MediaInfo>>;
  /** Writes whatever is still waiting for the debounce. */
  flush(): Promise<void>;
}

export interface LibraryFileFactsOptions {
  /** Where the readings are kept; nothing is written without one. */
  file?: string;
  probe: (key: string, signal: AbortSignal) => Promise<MediaInfo | undefined>;
  now?: () => number;
  concurrency?: number;
  probeTimeoutMs?: number;
  maxEntries?: number;
  saveDelayMs?: number;
}

/** A file ffprobe could not read is asked again after this long: a sleeping NAS that timed out
 *  once must not lose its facts until the file changes. */
const FAILURE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WAIT_MS = 1500;

const AUDIO_CODECS = new Set<string>(["aac", "ac3", "eac3", "dts", "truehd", "opus", "flac", "mp3"]);

const languages = (values: readonly (string | undefined)[]) =>
  [...new Set(values.filter((value): value is string => Boolean(value)))];

/** What a source row says about a read file: the languages it really holds and its main
 *  sound track. A track with no language tag adds nothing. */
export function localCopySummary(info: MediaInfo, subtitleSidecars: readonly (string | undefined)[]): {
  audioLanguages: string[];
  subtitleLanguages: string[];
  audioFacts?: AudioFacts;
} {
  const codec = info.audio?.codec && AUDIO_CODECS.has(info.audio.codec) ? info.audio.codec as AudioCodec : undefined;
  const channels = info.audio?.channels && info.audio.channels > 0 ? info.audio.channels : undefined;
  return {
    audioLanguages: languages(info.audioTracks.map((track) => track.language)),
    subtitleLanguages: languages([...info.subtitleTracks.map((track) => track.language), ...subtitleSidecars]),
    ...(codec || channels ? { audioFacts: { ...(codec ? { codec } : {}), ...(channels ? { channels } : {}) } } : {}),
  };
}

/** The variant indexes only matter to a conversion running now; they are not kept. */
const kept = (info: MediaInfo): MediaInfo => {
  const { variant: _variant, ...rest } = info;
  return rest;
};

export function createLibraryFileFacts(opts: LibraryFileFactsOptions): LibraryFileFacts {
  const now = opts.now ?? Date.now;
  const concurrency = opts.concurrency ?? 2;
  const probeTimeoutMs = opts.probeTimeoutMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 20_000;
  const saveDelayMs = opts.saveDelayMs ?? 2000;
  const entries = new Map<string, Entry>();
  const running = new Map<string, Promise<void>>();
  const waiting: Array<() => void> = [];
  let active = 0;
  let saveTimer: NodeJS.Timeout | undefined;
  let saving: Promise<void> = Promise.resolve();

  const loaded = (async () => {
    if (!opts.file) return;
    try {
      const parsed = JSON.parse(await readFile(opts.file, "utf8")) as { entries?: Record<string, Entry> };
      for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
        if (entry && typeof entry.size === "number" && typeof entry.modified === "string") entries.set(key, entry);
      }
    } catch (error) {
      // Only a cache: a missing or damaged file means every file is read again.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log("WARN", "Remembered library file facts could not be read, they will be read again", { reason: String(error).slice(0, 200) });
      }
    }
  })();

  const save = () => {
    if (!opts.file || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      saving = saving.then(write, write);
    }, saveDelayMs);
    saveTimer.unref?.();
  };

  const write = async () => {
    const file = opts.file!;
    try {
      await mkdir(path.dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      await writeFile(temp, JSON.stringify({ version: 1, entries: Object.fromEntries(entries) }), { mode: 0o600 });
      await renameWithRetry(temp, file);
    } catch (error) {
      log("WARN", "Library file facts could not be saved", { reason: String(error).slice(0, 200) });
    }
  };

  const remember = (key: string, entry: Entry) => {
    entries.delete(key);
    entries.set(key, entry);
    // The oldest readings go first; Map keeps insertion order.
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
    save();
  };

  const current = (file: LibraryFileStamp): Entry | undefined => {
    const entry = entries.get(file.key);
    if (!entry || entry.size !== file.size || entry.modified !== file.modified) return undefined;
    if (entry.info === null && now() - entry.at > FAILURE_TTL_MS) return undefined;
    return entry;
  };

  const slot = async () => {
    if (active < concurrency) { active += 1; return; }
    await new Promise<void>((resolve) => waiting.push(resolve));
  };
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };

  const inspect = (file: LibraryFileStamp): Promise<void> => {
    const pending = running.get(file.key);
    if (pending) return pending;
    const work = (async () => {
      await slot();
      try {
        if (current(file)) return;
        const info = await opts.probe(file.key, AbortSignal.timeout(probeTimeoutMs));
        remember(file.key, { size: file.size, modified: file.modified, info: info ? kept(info) : null, at: now() });
      } catch {
        // A library that went away or a probe cut off by its deadline says nothing about the
        // file itself; it is simply asked again next time.
      } finally {
        release();
        running.delete(file.key);
      }
    })();
    running.set(file.key, work);
    return work;
  };

  return {
    async read(files, readOpts) {
      await loaded;
      const pending = files.filter((file) => !current(file)).map(inspect);
      if (pending.length) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.allSettled(pending),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, readOpts?.waitMs ?? DEFAULT_WAIT_MS); }),
        ]);
        clearTimeout(timer);
      }
      const found = new Map<string, MediaInfo>();
      for (const file of files) {
        const info = current(file)?.info;
        if (info) found.set(file.key, info);
      }
      return found;
    },
    async flush() {
      await loaded;
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = undefined;
        saving = saving.then(write, write);
      }
      await saving;
    },
  };
}
