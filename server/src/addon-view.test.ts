import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { withProxiedArtwork } from "./addon-view.js";
import { ImageProxy } from "./images.js";
import { configureSecureMode } from "./secure.js";

const artworkView = (background?: unknown) => ({
  manifest: {
    id: "artwork",
    name: "Artwork",
    version: "1.0.0",
    logo: "https://art.example/logo.png",
    background,
  },
});

test("addon artwork follows secure mode and keeps a null background", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "addon-view-"));
  const proxy = new ImageProxy(directory);
  await proxy.load();
  try {
    const background = "https://art.example/background.jpg";
    configureSecureMode(() => true);
    const secure = withProxiedArtwork(artworkView(background), proxy);
    assert.match(String(secure.manifest.logo), /^\/api\/image\//);
    assert.match(String(secure.manifest.background), /^\/api\/image\//);

    configureSecureMode(() => false);
    const plain = artworkView(background);
    assert.equal(withProxiedArtwork(plain, proxy).manifest.background, background);
    const empty = artworkView(null);
    assert.equal(withProxiedArtwork(empty, proxy), empty);
    assert.equal(withProxiedArtwork(empty, proxy).manifest.background, null);
  } finally {
    configureSecureMode(() => true);
    await proxy.flush();
    await rm(directory, { recursive: true, force: true });
  }
});
