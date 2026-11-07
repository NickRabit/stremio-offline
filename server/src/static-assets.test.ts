import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http, { type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import express from "express";
import { pageRequestLimiter } from "./request-limits.js";
import { ASSET_CACHE_CONTROL, precompressedAssets } from "./static-assets.js";

interface RawResponse { status: number; headers: IncomingHttpHeaders; body: Buffer }

const rawRequest = (port: number, requestPath: string, method = "GET", acceptEncoding?: string): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method,
      headers: acceptEncoding === undefined ? {} : { "accept-encoding": acceptEncoding },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    request.end();
  });

async function fixture() {
  // A dot-segment in the install path (e2e runs from `e2e/.tmp/app`) must not make
  // `send` refuse the file as a dotfile.
  const directory = await mkdtemp(path.join(tmpdir(), ".stremio-static-assets-"));
  const assets = path.join(directory, "assets");
  await mkdir(assets);
  const script = Buffer.from("console.log('the uncompressed script');\n");
  const style = Buffer.from("body { color: white; }\n");
  const brotli = brotliCompressSync(script);
  const gzip = gzipSync(script);
  await Promise.all([
    writeFile(path.join(assets, "app.js"), script),
    writeFile(path.join(assets, "app.js.br"), brotli),
    writeFile(path.join(assets, "app.js.gz"), gzip),
    writeFile(path.join(assets, "plain.css"), style),
    // Brotli came out no smaller than the original, so the build kept only gzip.
    writeFile(path.join(assets, "gzip-only.js"), script),
    writeFile(path.join(assets, "gzip-only.js.gz"), gzip),
    writeFile(path.join(directory, "index.html"), "<!doctype html><title>Index</title>"),
  ]);

  const app = express();
  app.use(pageRequestLimiter({ limit: 1000 }));
  app.use(precompressedAssets(directory));
  app.use(express.static(directory, {
    setHeaders: (response, file) => {
      const relative = path.relative(assets, file);
      if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        response.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
        response.setHeader("Vary", "Accept-Encoding");
      }
    },
  }));
  app.use((_request, response) => response.status(404).send("fallback"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    script, style, brotli, gzip, port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("precompressed assets prefer brotli, fall back to gzip and then the plain file", async () => {
  const site = await fixture();
  try {
    const brotli = await rawRequest(site.port, "/assets/app.js", "GET", "gzip, br");
    assert.equal(brotli.status, 200);
    assert.equal(brotli.headers["content-encoding"], "br");
    assert.match(String(brotli.headers["content-type"]), /^text\/javascript|^application\/javascript/);
    assert.equal(brotli.headers.vary, "Accept-Encoding");
    assert.equal(brotli.headers["cache-control"], ASSET_CACHE_CONTROL);
    assert.deepEqual(brotli.body, site.brotli);

    const gzip = await rawRequest(site.port, "/assets/app.js", "GET", "gzip");
    assert.equal(gzip.headers["content-encoding"], "gzip");
    assert.deepEqual(gzip.body, site.gzip);

    const refused = await rawRequest(site.port, "/assets/app.js", "GET", "br;q=0, gzip;q=0");
    assert.equal(refused.headers["content-encoding"], undefined);
    assert.equal(refused.headers["cache-control"], ASSET_CACHE_CONTROL);
    assert.deepEqual(refused.body, site.script);

    const gzipAfterRefusingBrotli = await rawRequest(site.port, "/assets/app.js", "GET", "br;q=0, *;q=1");
    assert.equal(gzipAfterRefusingBrotli.headers["content-encoding"], "gzip");

    const plain = await rawRequest(site.port, "/assets/plain.css", "GET", "br, gzip");
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.match(String(plain.headers["content-type"]), /^text\/css/);
    assert.equal(plain.headers.vary, "Accept-Encoding");
    assert.equal(plain.headers["cache-control"], ASSET_CACHE_CONTROL);
    assert.deepEqual(plain.body, site.style);
  } finally {
    await site.close();
  }
});

test("precompressed assets follow the client's preference and fall back to the next encoding on disk", async () => {
  const site = await fixture();
  try {
    const preferred = await rawRequest(site.port, "/assets/app.js", "GET", "br;q=0.1, gzip;q=1");
    assert.equal(preferred.headers["content-encoding"], "gzip");
    assert.deepEqual(preferred.body, site.gzip);

    const fallback = await rawRequest(site.port, "/assets/gzip-only.js", "GET", "br, gzip");
    assert.equal(fallback.headers["content-encoding"], "gzip");
    assert.deepEqual(fallback.body, site.gzip);
  } finally {
    await site.close();
  }
});

test("precompressed assets keep HEAD bodies empty and do not resolve paths outside assets", async () => {
  const site = await fixture();
  try {
    const head = await rawRequest(site.port, "/assets/app.js", "HEAD", "br");
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-encoding"], "br");
    assert.equal(head.body.length, 0);

    for (const requestPath of ["/assets/..%2Findex.html", "/assets/../index.html"]) {
      const traversal = await rawRequest(site.port, requestPath, "GET", "br");
      assert.equal(traversal.headers["content-encoding"], undefined);
      assert.notEqual(traversal.headers["cache-control"], ASSET_CACHE_CONTROL);
    }
  } finally {
    await site.close();
  }
});
