import { randomBytes } from "node:crypto";
import { type MediaResources, type ResourceOwner } from "./media-resources.js";
import { RepeatFilter } from "./access-log.js";
import { log } from "./logger.js";

interface Grant { playbackId: string; owner: ResourceOwner; resourceId: string; token: string; expiresAt: number }

export class AirPlayAccess {
  private grants = new Map<string, Grant>();
  private sessions = new Map<string, string>();
  private refusals = new RepeatFilter();
  constructor(private resources: MediaResources, private now = Date.now) {}

  create(playbackId: string, owner: ResourceOwner, resourceId: string) {
    this.remove(playbackId);
    const token = randomBytes(32).toString("base64url");
    this.grants.set(token, { playbackId, owner, resourceId, token, expiresAt: Math.min(owner.expiresAt, this.now() + 12 * 60 * 60_000) });
    this.sessions.set(playbackId, token);
  }

  remove(playbackId: string) {
    const token = this.sessions.get(playbackId);
    if (token) this.grants.delete(token);
    this.sessions.delete(playbackId);
  }

  /** Drops every grant the predicate names. A sweep reaches a person or a piece of content,
   *  not one playback session, and a grant is a bearer credential that would otherwise
   *  outlive the request it was made for. */
  removeWhere(match: (grant: { playbackId: string; owner: ResourceOwner; resourceId: string }) => boolean) {
    for (const grant of [...this.grants.values()]) {
      if (!match(grant)) continue;
      this.grants.delete(grant.token);
      if (this.sessions.get(grant.playbackId) === grant.token) this.sessions.delete(grant.playbackId);
    }
  }

  url(playbackId: string, url: string): string {
    const token = this.sessions.get(playbackId);
    return token ? `${url}${url.includes("?") ? "&" : "?"}airplay=${token}` : url;
  }

  /** The token itself never reaches the log -- it is a bearer credential for the whole
   *  playback, and the log is what a user pastes into an issue. The reason is enough to
   *  tell an expired grant apart from a television asking for the wrong file. */
  private refuse(reason: string, pathname: string, playbackId?: string): undefined {
    const repeat = this.refusals.record(`${reason} ${pathname}`);
    if (repeat) log("WARN", "AirPlay request refused", {
      reason, path: pathname, playback: playbackId,
      ...(repeat.suppressed ? { alsoRefused: repeat.suppressed } : {}),
    });
    return undefined;
  }

  authorize(method: string, pathname: string, token: unknown): Grant | undefined {
    // No token at all is every ordinary request in the server; only one that claims to be
    // an AirPlay request is worth a word about being turned away.
    if (typeof token !== "string") return;
    if (!["GET", "HEAD"].includes(method)) return this.refuse("the method is not a read", pathname);
    const grant = this.grants.get(token);
    if (!grant) return this.refuse("no grant holds this token", pathname);
    if (grant.expiresAt <= this.now()) {
      this.remove(grant.playbackId);
      return this.refuse("the grant expired", pathname, grant.playbackId);
    }
    try {
      this.resources.get(grant.resourceId, grant.owner.sid, "media");
      const media = /^\/api\/media\/([A-Za-z0-9_-]{43})(?:\/u\/[A-Za-z0-9_-]+)?$/.exec(pathname);
      if (media) {
        const resource = this.resources.get(media[1], grant.owner.sid, "media");
        if ((resource.parent ?? resource.id) === grant.resourceId) return grant;
      }
      const segment = /^\/api\/playback\/([A-Za-z0-9-]+)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\.(?:m3u8|mp4|m4s|vtt)$/.exec(pathname);
      if (segment?.[1] === grant.playbackId) return grant;
      return this.refuse("the grant does not cover this file", pathname, grant.playbackId);
    } catch (error) {
      // The code, not the message: it says as much and cannot start carrying a source
      // address the day somebody makes the message more helpful.
      const code = (error as { code?: unknown })?.code;
      return this.refuse(`the resource is gone${typeof code === "string" ? ` (${code})` : ""}`, pathname, grant.playbackId);
    }
  }
}
