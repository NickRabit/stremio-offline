import { remoteContentAccessible } from "./media-server-access.js";
import type { MediaServerAuthority, MediaServerItemVersions, MediaServerManager } from "./media-server-manager.js";
import { isRemoteMediaStream, openRemoteContent, remoteSecretStamp, sealRemoteContent } from "./media-server-reference.js";
import { ResourceError, type MediaResources, type ResourceOwner } from "./media-resources.js";
import type { Store } from "./store.js";
import type { PublicStream, StreamItem } from "./types.js";
import type { UserRecord } from "./users.js";

/** One verified item's versions and its sealed subtitles as public sources. */
type SealedStreams = { stream: StreamItem; libraryName: string };

/** Trusted original-file sources: the only place a sealed media-server address is minted for
 *  a verified item, and the guard every later read passes through. It derives provider and
 *  library facts from the sealed reference, never from caller-supplied stream fields. */
export class MediaServerSources {
  constructor(
    private readonly store: Store,
    private readonly manager: MediaServerManager,
    private readonly resources: MediaResources,
  ) {}

  private accessSource() {
    return {
      users: () => this.store.users(),
      mediaConnections: () => this.store.mediaConnections(),
      remoteLibraries: () => this.store.remoteLibraries(),
    };
  }

  private currentUser(userId: string): UserRecord | undefined {
    return this.store.users().find((candidate) => candidate.id === userId);
  }

  /** A live session that can still read what the owner was granted, or nothing. */
  private ownerStamp(owner: ResourceOwner, authority: MediaServerAuthority): string {
    const user = this.currentUser(owner.userId);
    if (owner.userId !== authority.actor.id || !user || user.disabled || user.mustChangePassword
      || user.secret !== authority.actor.secret || user.revoked?.[owner.sid] || !(owner.expiresAt > Date.now())) {
      throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    }
    return remoteSecretStamp(user.secret);
  }

  /** An authority whose own re-check is the owner proof, so a revocation that reaches the
   *  manager mid-call is seen by the same validation the source service uses. */
  private authorityFor(stream: StreamItem, owner: ResourceOwner): MediaServerAuthority | undefined {
    const user = this.currentUser(owner.userId);
    if (!user) return undefined;
    return { actor: { id: user.id, secret: user.secret }, assertCurrent: () => { this.assertCurrent(stream, owner); } };
  }

  /** Ordinary originals and their external subtitles, each sealed with the full identity and
   *  the owner stamp. A subtitle reference shares the original's item, version and owner and
   *  adds only its provider index, so no caller can invent provenance for it. */
  private seal(result: MediaServerItemVersions, owner: ResourceOwner, secretStamp: string): SealedStreams[] {
    const base = {
      provider: result.identity.provider,
      serverId: result.identity.serverId,
      accountId: result.identity.accountId,
      itemId: result.identity.itemId,
      connectionId: result.connectionId,
      libraryId: result.libraryId,
      generation: result.generation,
      owner: { userId: owner.userId, sid: owner.sid, expiresAt: owner.expiresAt, secretStamp },
    };
    return result.versions.map((version) => ({
      libraryName: result.libraryName,
      stream: {
        url: sealRemoteContent({ ...base, mediaSourceId: version.id }),
        name: version.name ?? version.container ?? result.item.name,
        ...(version.size === undefined ? {} : { behaviorHints: { videoSize: version.size } }),
        ...(version.externalSubtitles?.length ? {
          subtitles: version.externalSubtitles.map((entry) => ({
            url: sealRemoteContent({ ...base, mediaSourceId: version.id, subtitleIndex: entry.index }),
            ...(entry.language ? { lang: entry.language } : {}),
            ...(entry.title ? { title: entry.title } : {}),
          })),
        } : {}),
      },
    }));
  }

  private listed(sealed: SealedStreams[], owner: ResourceOwner): PublicStream[] {
    const listed = this.resources.listing(sealed.map((entry) => entry.stream), owner);
    for (let index = 0; index < listed.length; index += 1) listed[index]!.libraryName = sealed[index]!.libraryName;
    return listed;
  }

  /** The verified versions of one item as public sources. Each is sealed with the full
   *  identity and the owner stamp, so no later caller can invent provenance. */
  async list(authority: MediaServerAuthority, owner: ResourceOwner, libraryId: string, itemId: string, signal?: AbortSignal): Promise<PublicStream[]> {
    const result = await this.manager.itemVersions(authority, libraryId, itemId, signal);
    const secretStamp = this.ownerStamp(owner, authority);
    return this.listed(this.seal(result, owner, secretStamp), owner);
  }

  /** The verified sources behind one exact external id, each candidate re-read and re-matched
   *  after the listing, so a title whose metadata moved mints nothing. `nameHint` is the
   *  resolved catalogue or series title, used only to bound a provider that cannot search by
   *  external id; it never widens what is matched. */
  async matched(authority: MediaServerAuthority, owner: ResourceOwner, libraryId: string, type: string, catalogId: string, signal?: AbortSignal, nameHint?: string): Promise<PublicStream[]> {
    const results = await this.manager.matchedVersions(authority, libraryId, type, catalogId, signal, nameHint);
    const secretStamp = this.ownerStamp(owner, authority);
    return this.listed(results.flatMap((result) => this.seal(result, owner, secretStamp)), owner);
  }

  /** Refuses any remote source that is not the exact one the owner session was granted, as
   *  the records stand now. A non-remote stream passes through untouched. */
  assertCurrent(stream: StreamItem, owner: ResourceOwner): void {
    if (!isRemoteMediaStream(stream)) return;
    const ref = openRemoteContent(stream.url);
    if (!(owner.expiresAt > Date.now()) || !ref || ref.owner.userId !== owner.userId || ref.owner.sid !== owner.sid || !(owner.expiresAt <= ref.owner.expiresAt)) {
      throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    }
    if (!remoteContentAccessible(this.accessSource(), ref)) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
  }

  /** Re-proves a remote source against the live remote policy before it is used. */
  async authorize(stream: StreamItem, owner: ResourceOwner, signal?: AbortSignal): Promise<void> {
    this.assertCurrent(stream, owner);
    if (!isRemoteMediaStream(stream)) return;
    const ref = openRemoteContent(stream.url);
    if (ref?.subtitleIndex !== undefined) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const authority = this.authorityFor(stream, owner);
    if (!ref || !authority) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    await this.manager.revalidateOriginal(authority, ref, signal);
    this.assertCurrent(stream, owner);
  }

  /** One sealed external subtitle as its validated bytes. The owner, the item, the version and
   *  the exact provider index are all re-proved before the bytes are read, and the owner proof
   *  runs again after them. */
  async readSubtitle(stream: StreamItem, owner: ResourceOwner, signal?: AbortSignal): Promise<{ bytes: Uint8Array; contentType: string }> {
    this.assertCurrent(stream, owner);
    if (!isRemoteMediaStream(stream)) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const ref = openRemoteContent(stream.url);
    if (!ref || ref.subtitleIndex === undefined) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const authority = this.authorityFor(stream, owner);
    if (!authority) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const asset = await this.manager.readSubtitle(authority, ref, signal);
    this.assertCurrent(stream, owner);
    return asset;
  }

  /** Opens the original behind a remote source. The owner guard runs before and after the
   *  manager call; a refusal cancels the body rather than handing it over. */
  async open(stream: StreamItem, owner: ResourceOwner, args: { method: "GET" | "HEAD"; range?: string }, signal?: AbortSignal): Promise<Response> {
    if (!isRemoteMediaStream(stream)) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    this.assertCurrent(stream, owner);
    const ref = openRemoteContent(stream.url);
    if (ref?.subtitleIndex !== undefined) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const authority = this.authorityFor(stream, owner);
    if (!ref || !authority) throw new ResourceError(404, "RESOURCE_NOT_FOUND");
    const response = await this.manager.openOriginal(authority, ref, args, signal);
    try {
      this.assertCurrent(stream, owner);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    return response;
  }
}
