import type { DownloadQueue } from "./downloads.js";
import type { FollowQueue } from "./follows.js";

export const createFollowQueueAdapter = (queue: DownloadQueue): FollowQueue => ({
  addPending: (title, source, media, ownerUserId, follow, sourceAdmission) =>
    queue.addPending(title, source, media, ownerUserId, follow, sourceAdmission),
  findActiveEpisode: (ownerUserId, type, videoId) =>
    queue.findActiveEpisode(ownerUserId, type, videoId),
  adopt: (id, follow) => queue.adopt(id, follow),
  followJobs: () => queue.followJobs(),
  get: (id) => queue.get(id),
  retry: (id, selection, sourceAdmission) => queue.retry(id, selection, sourceAdmission),
  remove: (id) => queue.remove(id),
});
