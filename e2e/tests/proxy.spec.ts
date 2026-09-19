import { expect, test, type APIRequestContext } from "@playwright/test";
import { addonManifest } from "../../playwright.config";

const control = (request: APIRequestContext, mode: string) => request.get(new URL(`/proxy-control?mode=${mode}`, addonManifest).href);
async function start(request: APIRequestContext, airplay = false) {
  await control(request, "video");
  const sources = await (await request.get("/api/streams/movie/tt-e2e-proxy")).json();
  const response = await request.post("/api/playback", { data: { sourceId: sources[0].sourceId, capabilities: { h264: true, aac: true, airplay } } });
  expect(response.status(), await response.text()).toBe(201);
  const playback = await response.json();
  expect(playback.mode).toBe("direct");
  expect(playback.url).toMatch(airplay ? /^\/api\/media\/[\w-]{43}\?airplay=[\w-]{43}$/ : /^\/api\/media\/[\w-]{43}$/);
  return { ...playback, source: sources[0] };
}

test("AirPlay receivers read media without cookies but cannot access other resources or controls", async ({ request, playwright }) => {
  const playback = await start(request, true);
  const other = await start(request);
  const receiver = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  const query = new URL(playback.url, "http://test").search;
  try {
    const range = await receiver.get(playback.url, { headers: { range: "bytes=0-31" } });
    expect(range.status()).toBe(206);
    expect((await range.body()).length).toBe(32);
    expect((await receiver.head(playback.url)).status()).toBe(200);
    expect((await receiver.get(playback.url.split("?")[0])).status()).toBe(401);
    expect((await receiver.get(`${other.url}${query}`)).status()).toBe(401);
    expect((await receiver.get(`/api/settings${query}`)).status()).toBe(401);
    expect((await receiver.post(`/api/playback/${playback.id}/seek${query}`, { data: { time: 1 } })).status()).toBe(401);
    await control(request, "playlist");
    const playlist = await (await receiver.get(playback.url)).text();
    const children = [...playlist.matchAll(/\/api\/media\/[\w-]{43}\/u\/[\w-]+\?airplay=[\w-]{43}/g)].map(([url]) => url);
    expect(children).toHaveLength(3);
    for (const url of children) expect((await receiver.get(url)).status()).toBe(200);
    await request.delete(`/api/playback/${playback.id}`);
    for (const url of [playback.url, ...children]) expect((await receiver.get(url)).status()).toBe(401);
  } finally {
    await receiver.dispose();
    await request.delete(`/api/playback/${playback.id}`);
    await request.delete(`/api/playback/${other.id}`);
    await control(request, "video");
  }
});

test("AirPlay HLS carries access through master, variant, init and segments after a track change", async ({ request, playwright }) => {
  const playback = await start(request, true);
  const receiver = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const changed = await request.post(`/api/playback/${playback.id}/track`, { data: { quality: 480, time: 0 } });
    expect(changed.status()).toBe(200);
    const converted = await changed.json();
    const master = await receiver.get(converted.url);
    expect(master.status(), await master.text()).toBe(200);
    const variants = (await master.text()).split("\n").filter((line) => line && !line.startsWith("#"));
    expect(variants.length).toBeGreaterThan(0);
    const base = new URL(converted.url, test.info().project.use.baseURL);
    const variant = await receiver.get(new URL(variants[0], base).href);
    expect(variant.status()).toBe(200);
    const text = await variant.text();
    const init = /URI="([^"]+)"/.exec(text)![1];
    const segment = text.split("\n").find((line) => line && !line.startsWith("#"))!;
    for (const uri of [init, segment]) {
      expect(uri).toContain("?airplay=");
      const response = await receiver.get(new URL(uri, base).href);
      expect(response.status()).toBe(200);
      expect((await response.body()).length).toBeGreaterThan(0);
    }
  } finally {
    await receiver.dispose();
    await request.delete(`/api/playback/${playback.id}`);
  }
});

test("AirPlay receiver access is revoked when its owner logs out", async ({ playwright }) => {
  const options = { baseURL: test.info().project.use.baseURL, storageState: { cookies: [], origins: [] } };
  const owner = await playwright.request.newContext(options);
  const receiver = await playwright.request.newContext(options);
  try {
    expect((await owner.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } })).status()).toBe(200);
    const playback = await start(owner, true);
    expect((await receiver.get(playback.url)).status()).toBe(200);
    expect((await owner.post("/api/auth/logout", { data: {} })).status()).toBe(204);
    expect((await receiver.get(playback.url)).status()).toBe(401);
  } finally {
    await owner.dispose();
    await receiver.dispose();
  }
});

test("opaque proxy suppresses provider errors and sensitive response headers", async ({ request }) => {
  const playback = await start(request);
  for (const status of [200, 302, 401, 403, 500, 416]) {
    await control(request, String(status));
    const response = await request.get(playback.url);
    expect(response.status()).toBe(status === 200 ? 200 : status === 416 ? 416 : 502);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    for (const name of ["set-cookie", "link", "location", "www-authenticate"]) expect(response.headers()[name]).toBeUndefined();
    expect(await response.text()).not.toContain("provider-canary");
    if (status === 416) expect(response.headers()["content-range"]).toBe("bytes */123");
  }
  await request.delete(`/api/playback/${playback.id}`);
});

test("opaque proxy preserves media ranges and HEAD metadata", async ({ request }) => {
  const playback = await start(request);
  const response = await request.get(playback.url, { headers: { range: "bytes=0-31" } });
  expect(response.status()).toBe(206);
  expect((await response.body()).length).toBe(32);
  expect(response.headers()["content-range"]).toMatch(/^bytes 0-31\//);
  const head = await request.head(playback.url, { headers: { range: "bytes=0-31" } });
  expect(head.status()).toBe(206);
  expect(head.headers()["content-length"]).toBe("32");
  expect((await head.body()).length).toBe(0);
  await control(request, "head");
  expect((await request.head(playback.url)).status()).toBe(200);
  await request.delete(`/api/playback/${playback.id}`);
});

test("HLS children are opaque, deduplicated and revoked with their playback", async ({ request }) => {
  const playback = await start(request);
  await control(request, "playlist");
  const response = await request.get(playback.url);
  expect(response.status()).toBe(200);
  const playlist = await response.text();
  expect(playlist).not.toMatch(/canary|token=|headers=|url=/);
  expect(await (await request.get(playback.url)).text()).toBe(playlist);
  const children = [...playlist.matchAll(/\/api\/media\/[\w-]{43}\/u\/[\w-]+/g)].map(([value]) => value);
  expect(children).toHaveLength(3);
  expect(new Set(children.map((path) => path.split("/")[3])).size).toBe(1);
  for (const child of children) expect((await request.get(child)).status()).toBe(200);
  await request.delete(`/api/playback/${playback.id}`);
  // Gone, not missing. A player closed mid-read still has range requests in the air, and
  // 404 invites it to send them again -- which it did, 56 times in half a second.
  for (const child of children) expect((await request.get(child)).status()).toBe(410);
});

test("sources, playback, subtitles and downloads enforce session ownership and reject raw input", async ({ request, playwright }) => {
  const playback = await start(request);
  const serialized = JSON.stringify(playback);
  expect(serialized).not.toMatch(/canary|proxyHeaders|externalUrl/);
  const subtitle = `/api/subtitle/${playback.source.subtitles[0].subtitleId}`;
  expect((await request.get(subtitle)).status()).toBe(200);
  const prepared = await request.post("/api/device-download", { data: { sourceId: playback.source.sourceId } });
  expect(prepared.status()).toBe(201);
  const ticket = await prepared.json();
  expect((await request.get(ticket.url)).status()).toBe(200);
  const foreign = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  for (const url of [playback.url, subtitle, ticket.url, `/api/playback/${playback.id}/preview?time=0`, `/api/library/next/${playback.source.sourceId}`]) expect((await foreign.get(url)).status()).toBe(404);
  expect((await foreign.post(`/api/playback/${playback.id}/seek`, { data: { time: 1 } })).status()).toBe(404);
  expect((await foreign.post("/api/inspect", { data: { sourceId: playback.source.sourceId } })).status()).toBe(404);
  expect((await request.post("/api/downloads", { data: { sourceId: playback.url.split("/").pop() } })).status()).toBe(404);
  for (const route of ["/api/inspect", "/api/playback", "/api/downloads", "/api/device-download"]) {
    expect((await request.post(route, { data: { sourceId: playback.source.sourceId, stream: { url: "https://provider-canary.test" } } })).status()).toBe(400);
  }
  for (const route of ["/api/proxy", "/api/proxy/", "/api/subtitle", "/api/library/file"]) expect((await request.get(`${route}?url=https://provider-canary.test`)).status()).toBe(410);
  expect((await request.get("/api/media/forged", { headers: { "x-forwarded-for": "127.0.0.1" } })).status()).toBe(404);
  const ownedByForeign = await start(foreign);
  await foreign.post("/api/auth/logout", { data: {} });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  expect((await foreign.get(ownedByForeign.url)).status()).toBe(404);
  await foreign.dispose();
  await request.delete(`/api/playback/${playback.id}`);
});

test("browser playback renders from the server and never requests provider media", async ({ page, request }) => {
  await control(request, "browser");
  const providerMedia: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.port === new URL(addonManifest).port && (url.pathname.startsWith("/video/") || url.pathname === "/browser-video.webm")) providerMedia.push(url.href);
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Katalog", exact: true }).click();
  const catalog = page.getByRole("combobox", { name: "Procházet katalog" });
  const option = await catalog.locator("option").filter({ hasText: "Filmy" }).first().getAttribute("value");
  await catalog.selectOption(option!);
  await page.getByRole("button", { name: /Zkušební film/ }).click();
  await page.getByRole("button", { name: "Přehrát", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime), { timeout: 15_000 }).toBeGreaterThan(0);
  expect(await video.getAttribute("src")).toMatch(/^\/api\/media\/[\w-]{43}$/);
  expect(providerMedia).toEqual([]);
  await control(request, "video");
});

test("converted generations retain playback ownership", async ({ request, playwright }) => {
  const playback = await start(request);
  const changed = await request.post(`/api/playback/${playback.id}/track`, { data: { quality: 480, time: 0 } });
  expect(changed.status(), await changed.text()).toBe(200);
  const converted = await changed.json();
  expect(converted.mode).toBe("transcode");
  expect(converted.url).toMatch(/^\/api\/playback\//);
  const master = await request.get(converted.url);
  expect(master.status()).toBe(200);
  const mediaPath = converted.url.replace("master.m3u8", "index-0.m3u8");
  const playlist = await request.get(mediaPath);
  expect(playlist.status()).toBe(200);
  const text = await playlist.text();
  expect(text).not.toMatch(/query-canary|header-canary|token=/);
  const foreign = await playwright.request.newContext({ baseURL: test.info().project.use.baseURL });
  await foreign.post("/api/auth/login", { data: { username: "e2e-admin", password: "e2e-password" } });
  expect((await foreign.get(mediaPath)).status()).toBe(404);
  await foreign.dispose();
  await request.delete(`/api/playback/${playback.id}`);
  expect((await request.get(mediaPath)).status()).toBe(404);
});

test("local playback and device downloads use opaque resources", async ({ request }) => {
  await expect.poll(async () => (await (await request.get("/api/downloads")).json()).jobs.some((job: { status: string }) => job.status === "completed")).toBe(true);
  const jobs = (await (await request.get("/api/downloads")).json()).jobs;
  const job = jobs.find((item: { status: string }) => item.status === "completed");
  const sourceResponse = await request.post("/api/library/source", { data: { path: job.target } });
  expect(sourceResponse.status()).toBe(200);
  const source = await sourceResponse.json();
  expect(source.kind).toBe("library");
  expect(JSON.stringify(source)).not.toContain("file://");
  const response = await request.post("/api/playback", { data: { sourceId: source.sourceId, capabilities: { h264: true, aac: true } } });
  expect(response.status(), await response.text()).toBe(201);
  const playback = await response.json();
  expect(playback.url).toMatch(/^\/api\/media\/[\w-]{43}$/);
  const range = await request.get(playback.url, { headers: { range: "bytes=0-15" } });
  expect(range.status()).toBe(206);
  expect((await range.body()).length).toBe(16);
  const prepared = await request.post("/api/device-download", { data: { sourceId: source.sourceId } });
  expect(prepared.status()).toBe(201);
  expect((await request.get((await prepared.json()).url)).status()).toBe(200);
  expect((await request.post("/api/library/source", { data: { path: "../../etc/passwd" } })).status()).toBe(404);
  await request.delete(`/api/playback/${playback.id}`);
});


test("timeline previews return private JPEG frames and expire with playback", async ({ request }) => {
  const playback = await start(request);
  const url = `/api/playback/${playback.id}/preview?time=0`;
  const frame = await request.get(url);
  expect(frame.status()).toBe(200);
  expect(frame.headers()["content-type"]).toContain("image/jpeg");
  expect(frame.headers()["cache-control"]).toContain("no-store");
  expect((await frame.body()).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  expect(await (await request.get(url)).body()).toEqual(await frame.body());
  expect((await request.get(`/api/playback/${playback.id}/preview?time=-1`)).status()).toBe(204);
  await request.delete(`/api/playback/${playback.id}`);
  expect((await request.get(url)).status()).toBe(404);
});

test("a source that drops the connection is asked again instead of failing the playback", async ({ request }) => {
  const playback = await start(request);
  try {
    // The host hangs up on the next request, as these do on a large file, and answers the one after.
    await control(request, "drop-once");
    const response = await request.get(playback.url, { headers: { range: "bytes=0-31" } });
    expect(response.status(), await response.text()).toBe(206);
    expect((await response.body()).length).toBe(32);
  } finally {
    await control(request, "video");
    await request.delete(`/api/playback/${playback.id}`);
  }
});

test("a source that has gone quiet is given up on quickly, not after a minute of retries", async ({ request }) => {
  // The first attempt waits out the full header timeout on purpose; that is the point of the test.
  test.setTimeout(120_000);
  // Ranges nothing has read, so the request really reaches the source rather than the cache.
  const playback = await start(request);
  try {
    // The host takes the request and never answers, which is what these do once they are upset.
    await control(request, "hang");
    const first = Date.now();
    expect((await request.get(playback.url, { headers: { range: "bytes=2048-2079" } })).status()).toBe(400);
    const waited = Date.now() - first;
    // The next viewer's click must not wait for the whole ordeal again.
    const second = Date.now();
    expect((await request.get(playback.url, { headers: { range: "bytes=2080-2111" } })).status()).toBe(400);
    const again = Date.now() - second;
    expect(again, `first ${waited} ms, second ${again} ms`).toBeLessThan(Math.max(12_000, waited / 2));
  } finally {
    await control(request, "video");
    await request.delete(`/api/playback/${playback.id}`);
  }
});

test("a transfer the source cuts is picked up where it stopped", async ({ request }) => {
  const playback = await start(request);
  try {
    const whole = await request.get(playback.url, { headers: { range: "bytes=0-2047" } });
    expect(whole.status()).toBe(206);
    const expected = await whole.body();
    // The host hands over a few bytes of the next one and hangs up mid-transfer.
    await control(request, "cut-once");
    const cut = await request.get(playback.url, { headers: { range: "bytes=0-2047" } });
    expect(cut.status()).toBe(206);
    const received = await cut.body();
    expect(received.length, "the range comes back whole, not truncated").toBe(expected.length);
    expect(received.equals(expected)).toBe(true);
  } finally {
    await control(request, "video");
    await request.delete(`/api/playback/${playback.id}`);
  }
});

test("a read the source already answered is not asked for twice", async ({ request }) => {
  const playback = await start(request);
  try {
    await request.get(new URL("/proxy-control?mode=video&reset=1", addonManifest).href);
    const asked = async () => (await (await request.get(new URL("/proxy-requests", addonManifest).href)).json()).requests as number;

    // A stretch nothing has read yet, so the first one has to go to the source.
    const first = await request.get(playback.url, { headers: { range: "bytes=1024-1279" } });
    expect(first.status()).toBe(206);
    const once = await asked();
    expect(once).toBeGreaterThan(0);

    // What every FFmpeg reads first -- the header, and the index at the far end -- comes back
    // without the source hearing about it, which is the whole point on a host that counts.
    const again = await request.get(playback.url, { headers: { range: "bytes=1024-1279" } });
    expect(again.status()).toBe(206);
    expect((await again.body()).equals(await first.body())).toBe(true);
    expect(await asked(), "the source was asked once, not twice").toBe(once);
  } finally {
    await request.delete(`/api/playback/${playback.id}`);
  }
});
