import { addonAllowed } from "./addons.js";
import type { AirPlayAccess } from "./airplay-access.js";
import { readSession } from "./auth.js";
import { mayDownloadToDevice, mayDownloadToLibrary, type DownloadJob } from "./downloads.js";
import { libraryVisible, parseLibraryPath, type LibraryRecord, type Viewer } from "./libraries.js";
import { log } from "./logger.js";
import type { DeviceDownloadTicket, MediaResources, ResourceOwner } from "./media-resources.js";
import type { AddonRecord, StreamItem } from "./types.js";
import { findUserById, type UserRecord } from "./users.js";

/**
 * Withdrawing access has to reach what is already in flight, and it has to hold against a
 * request that read its permissions and then waited. The two halves are different problems
 * and neither covers the other:
 *
 *  - a sweep stops the resources, grants, transfers and jobs that already exist, and
 *  - the re-check below stops a resource that a request mints after the sweep has passed.
 *
 * Data already delivered cannot be recalled. What either half reaches is everything not
 * yet finished: a film being read, a subtitle being fetched, a ticket not yet redeemed.
 */

/** What a request held when it resolved its account. Captured once, at the start of the
 *  request, and compared again at the moment it hands something over. */
export interface AccessClaim { userId: string; sid: string; token: string; permissionsVersion: number }

/** The right a request is about to exercise and the content it is about to hand over. Step
 *  five of the chain -- the library or the addon as it stands now -- is not covered by any
 *  counter, so it is read here rather than inferred from the version. */
export interface AccessNeed {
  permission?: "downloadToLibrary" | "downloadToDevice";
  addonKey?: string;
  libraryId?: string;
}

/** The state the re-check reads. Structural, so this module stays free of the store. */
export interface AccessSource {
  users(): UserRecord[];
  addons(): AddonRecord[];
  libraries(): LibraryRecord[];
}

/**
 * Whether the request may no longer be answered. The whole chain is validated, not the
 * counter alone: the account, its session, the secret behind the token, the rights and the
 * content itself. A password change rotates the secret and moves no counter, and an
 * administrator switching an addon off moves no counter at all -- both have to be caught.
 */
export function accessLost(source: AccessSource, claim: AccessClaim | undefined, need: AccessNeed = {}): boolean {
  if (!claim) return true;
  const user = findUserById(source.users(), claim.userId);
  if (!user || user.disabled) return true;
  if (user.revoked?.[claim.sid]) return true;
  // The token is checked against the secret the account has now, which is what notices a
  // password change mid-request.
  const session = readSession(user.secret, claim.token);
  if (!session || session.userId !== claim.userId || session.sid !== claim.sid) return true;
  const viewer: Viewer = { id: user.id, role: user.role };
  if (need.libraryId !== undefined) {
    const library = source.libraries().find((item) => item.id === need.libraryId);
    if (!library || !library.enabled || !libraryVisible(library, viewer)) return true;
  }
  if (need.addonKey !== undefined) {
    const addon = source.addons().find((item) => item.key === need.addonKey);
    if (!addon || !addon.enabled || !addonAllowed(addon, viewer)) return true;
  }
  if (user.permissionsVersion !== claim.permissionsVersion) {
    // The counter moved, so the right has to re-resolve from the account as it stands now
    // rather than be assumed: an edit that took it away and one that gave it back look the
    // same from here.
    if (need.permission === "downloadToLibrary" && !mayDownloadToLibrary(user)) return true;
    if (need.permission === "downloadToDevice" && !mayDownloadToDevice(user)) return true;
  }
  return false;
}

/** What a stream belongs to: the addon that named it, or the library its file lives in. */
export function contentOf(stream: Pick<StreamItem, "addonKey" | "url">): { addonKey?: string; libraryId?: string } {
  return {
    addonKey: stream.addonKey,
    libraryId: typeof stream.url === "string" && stream.url.startsWith("file://")
      ? parseLibraryPath(stream.url.slice(7))?.libraryId
      : undefined,
  };
}

/** A response still being written to a client. Destroying it is what actually stops the
 *  transfer; `resourceId` places it in the media registry, and a device download names its
 *  content instead because its ticket is not a media resource. */
export interface ActiveTransfer {
  owner: ResourceOwner;
  res: { destroy(): void };
  resourceId?: string;
  device?: boolean;
  addonKey?: string;
  libraryId?: string;
}

/** The queue as a sweep reaches it. A job is owner-bound, not session-bound: sign-out, a
 *  password change and a restart never come here, and a job stops only when the permission
 *  behind it goes -- and then it pauses, keeping its place. */
export interface RevocationQueue {
  ownerOf(job: Pick<DownloadJob, "ownerUserId">): string | undefined;
  /** Pauses every job the predicate names and answers how many it paused. */
  pauseMatching(match: (job: DownloadJob) => boolean): Promise<number>;
  /** Drops every unfinished job the predicate names, partial files with them. */
  removeMatching(match: (job: DownloadJob) => boolean): Promise<number>;
}

export interface RevocationDeps {
  /** What exists now, read the way `accessLost` reads it. A sweep that follows a change of
   *  role cannot be told which libraries and addons were lost -- there may be every one of
   *  them -- so it works the answer out instead. */
  source: AccessSource;
  resources: MediaResources;
  airplay: AirPlayAccess;
  playbackOwners: Map<string, { owner: ResourceOwner; resourceId: string }>;
  activeMedia: Set<ActiveTransfer>;
  deviceTickets: Map<string, DeviceDownloadTicket>;
  /** Stops one playback session, through the same release hook a player's own stop uses. */
  stopPlayback(id: string): Promise<unknown>;
  queue: RevocationQueue;
}

/** The two causes that are not a user or a piece of content: one library or addon, held by
 *  one account (or by everybody, when no user is named). */
export interface StopContentOptions { userId?: string; libraryId?: string; addonKey?: string }

interface Content { addonKey?: string; libraryId?: string }

export class Revocations {
  constructor(private deps: RevocationDeps) {}

  /** Everything one session holds. Another device of the same person is untouched, because
   *  `sid` is what keeps a phone and a television apart. */
  async stopSession(sid: string): Promise<void> {
    this.deps.resources.revoke(sid);
    for (const active of this.deps.activeMedia) if (active.owner.sid === sid) active.res.destroy();
    for (const [id, owned] of this.deps.playbackOwners) if (owned.owner.sid === sid) await this.deps.stopPlayback(id);
    for (const [id, ticket] of this.deps.deviceTickets) if (ticket.owner.sid === sid) this.deps.deviceTickets.delete(id);
    this.deps.airplay.removeWhere((grant) => grant.owner.sid === sid);
  }

  /** Everything one account holds, across all its devices. Its jobs pause: they are not a
   *  session, and the work is not wrong, so the queue keeps its place for when the right is
   *  back. */
  async stopUser(userId: string): Promise<void> {
    await this.stopUserTransfers(userId);
    await this.pauseJobs((job) => this.deps.queue.ownerOf(job) === userId, userId);
  }

  /** The account is gone rather than switched off: the queue loses the work too, and the
   *  partial files go with it. Completed files stay in the library. */
  async deleteUser(userId: string): Promise<void> {
    await this.stopUserTransfers(userId);
    const removed = await this.deps.queue.removeMatching((job) => this.deps.queue.ownerOf(job) === userId);
    if (removed) log("INFO", "Unfinished downloads cancelled with the account", { user: userId, jobs: removed });
  }

  /** Everything one account is *holding open* -- its media, playback, tickets and AirPlay
   *  grants, on every device -- and nothing else. This is what a sign-out everywhere and a
   *  password change reach for: the queue is owner-bound rather than session-bound, so a
   *  download must survive both. Closing a laptop is not a reason to stop a film downloading.
   */
  async stopUserSessions(userId: string): Promise<void> {
    await this.stopUserTransfers(userId);
  }

  private async stopUserTransfers(userId: string): Promise<void> {
    this.deps.resources.revokeUser(userId);
    for (const active of this.deps.activeMedia) if (active.owner.userId === userId) active.res.destroy();
    for (const [id, owned] of this.deps.playbackOwners) if (owned.owner.userId === userId) await this.deps.stopPlayback(id);
    for (const [id, ticket] of this.deps.deviceTickets) if (ticket.owner.userId === userId) this.deps.deviceTickets.delete(id);
    this.deps.airplay.removeWhere((grant) => grant.owner.userId === userId);
  }

  /** One account's hold on one library or addon. With no user, every account at once --
   *  which is what switching a library or an addon off globally needs. */
  async stopContent(opts: StopContentOptions): Promise<void> {
    const matches = (owner: ResourceOwner, content: Content): boolean => {
      if (opts.userId !== undefined && owner.userId !== opts.userId) return false;
      if (opts.addonKey !== undefined && content.addonKey === opts.addonKey) return true;
      if (opts.libraryId !== undefined && content.libraryId === opts.libraryId) return true;
      return false;
    };
    const revoked = new Set(this.deps.resources.revokeWhere((owner, stream) => matches(owner, contentOf(stream))));
    for (const active of this.deps.activeMedia) {
      if (active.resourceId ? revoked.has(active.resourceId) : matches(active.owner, active)) active.res.destroy();
    }
    for (const [id, owned] of this.deps.playbackOwners) {
      if (revoked.has(owned.resourceId) && (opts.userId === undefined || owned.owner.userId === opts.userId)) await this.deps.stopPlayback(id);
    }
    this.deps.airplay.removeWhere((grant) => revoked.has(grant.resourceId));
    // A device-download ticket is deliberately left out here. It is not a session and not a
    // content resource: its right is `downloadToDevice`, and the transfer it starts reads the
    // library and the addon again at redemption, so an unredeemed one refuses there.
    await this.pauseJobs((job) => this.jobTouches(job, opts), opts.userId);
  }

  /** Everything one account is holding that it may no longer reach. A change of role cannot
   *  name the content it costs -- an administrator reaches every library and every addon by
   *  role, and an ordinary account reaches only what it was granted -- so what is held is
   *  measured against what is now allowed, one item at a time. */
  async stopUnreachable(user: UserRecord): Promise<void> {
    const viewer: Viewer = { id: user.id, role: user.role };
    const libraries = this.deps.source.libraries();
    const addons = this.deps.source.addons();
    const lost = (content: Content): boolean => {
      if (content.libraryId !== undefined) {
        const library = libraries.find((item) => item.id === content.libraryId);
        if (!library || !library.enabled || !libraryVisible(library, viewer)) return true;
      }
      if (content.addonKey !== undefined) {
        const addon = addons.find((item) => item.key === content.addonKey);
        if (!addon || !addon.enabled || !addonAllowed(addon, viewer)) return true;
      }
      return false;
    };
    const mine = (owner: ResourceOwner) => owner.userId === user.id;
    const revoked = new Set(this.deps.resources.revokeWhere((owner, stream) => mine(owner) && lost(contentOf(stream))));
    for (const active of this.deps.activeMedia) {
      if (!mine(active.owner)) continue;
      if (active.resourceId ? revoked.has(active.resourceId) : lost(active)) active.res.destroy();
    }
    for (const [id, owned] of this.deps.playbackOwners) {
      if (mine(owned.owner) && revoked.has(owned.resourceId)) await this.deps.stopPlayback(id);
    }
    this.deps.airplay.removeWhere((grant) => revoked.has(grant.resourceId));
    // A queued download keeps its place, like every other pause: the job is not wrong, the
    // library it writes to is simply not this account's to write to any more.
    await this.pauseJobs((job) => this.deps.queue.ownerOf(job) === user.id && (lost({
      libraryId: job.libraryId ?? (job.target ? parseLibraryPath(job.target)?.libraryId : undefined),
      addonKey: job.stream?.addonKey,
    }) || lost({ addonKey: job.subtitle?.addonKey })), user.id);
  }

  /**
   * The download rights an account has just lost. Each cause reaches only what it covered:
   * taking away the right to queue must not stop the film somebody is watching, and taking
   * away the right to save to the device must not stop the queue. A disabled account is a
   * different change -- everything of theirs goes -- so it is handled as the whole account.
   */
  async permissionsChanged(before: UserRecord, after: UserRecord): Promise<void> {
    if (before.id !== after.id) return;
    if (!before.disabled && after.disabled) {
      await this.stopUser(after.id);
      return;
    }
    // Coming down from administrator is the largest withdrawal there is: everything the role
    // was granting goes at once, and what is left is whatever the resources name explicitly,
    // which is usually nothing. The counter stops the next request; this reaches the film
    // already playing and the transfer already running.
    if (before.role === "admin" && after.role !== "admin") await this.stopUnreachable(after);
    if (mayDownloadToLibrary(before) && !mayDownloadToLibrary(after)) {
      await this.pauseJobs((job) => this.deps.queue.ownerOf(job) === after.id, after.id);
    }
    if (mayDownloadToDevice(before) && !mayDownloadToDevice(after)) {
      this.dropDeviceAccess(after.id);
    }
  }

  /** The tickets of one account and the transfers reading them, unredeemed and in use. */
  private dropDeviceAccess(userId: string) {
    for (const [id, ticket] of this.deps.deviceTickets) if (ticket.owner.userId === userId) this.deps.deviceTickets.delete(id);
    for (const active of this.deps.activeMedia) if (active.device && active.owner.userId === userId) active.res.destroy();
  }

  /** A job whose source or target is the withdrawn content. A lazy job has no source yet:
   *  the queue asks its own owner-bound check when it resolves one, so it is left alone
   *  here rather than guessed at. */
  private jobTouches(job: DownloadJob, opts: StopContentOptions): boolean {
    if (opts.userId !== undefined && this.deps.queue.ownerOf(job) !== opts.userId) return false;
    if (opts.libraryId !== undefined) {
      const libraryId = job.libraryId ?? (job.target ? parseLibraryPath(job.target)?.libraryId : undefined);
      if (libraryId === opts.libraryId) return true;
    }
    // The subtitle counts as much as the video: it is commonly chosen from another addon and
    // is fetched on resume, which can be long after that addon was taken away.
    return opts.addonKey !== undefined
      && (job.stream?.addonKey === opts.addonKey || job.subtitle?.addonKey === opts.addonKey);
  }

  private async pauseJobs(match: (job: DownloadJob) => boolean, userId?: string) {
    const paused = await this.deps.queue.pauseMatching(match);
    if (paused) log("INFO", "Downloads paused, the permission behind them is gone", { user: userId });
  }
}
