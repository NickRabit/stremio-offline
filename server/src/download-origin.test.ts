import assert from "node:assert/strict";
import test from "node:test";
import { downloadOrigin } from "./downloads.js";

test("a job exposes only names of where its file comes from", () => {
  assert.equal(downloadOrigin({}), undefined);
  assert.deepEqual(downloadOrigin({ stream: { url: "https://x/y?token=1", addonName: "Torrentio" } }), { addon: "Torrentio" });
  assert.deepEqual(downloadOrigin({ stream: { infoHash: "abc", addonName: "Torrentio" } }), { addon: "Torrentio", debrid: true });
  assert.deepEqual(downloadOrigin({ stream: { infoHash: "abc" } }), { debrid: true });
  assert.deepEqual(downloadOrigin({ stream: { url: "https://x/y" } }), undefined);
  assert.deepEqual(downloadOrigin({ reusedLocalCopy: true, stream: { addonName: "Torrentio" } }), { localCopy: true });
  assert.deepEqual(downloadOrigin({ remoteDownload: { provider: "jellyfin" } as never }), { remote: "jellyfin" });
});
