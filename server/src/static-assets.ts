import express from "express";
import path from "node:path";
import { stat } from "node:fs/promises";

export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

type Encoding = "br" | "gzip";
const SUFFIX: Record<Encoding, string> = { br: ".br", gzip: ".gz" };

/** The encodings the client accepts, its preferred first; brotli wins a tie. */
function acceptedEncodings(header: string | undefined): Encoding[] {
  if (!header) return [];
  const values = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...parameters] = part.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const q = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const value = q === undefined ? 1 : Number(q.split("=")[1]);
    values.set(name, Number.isFinite(value) && value > 0 ? value : 0);
  }
  const weight = (encoding: Encoding) => values.get(encoding) ?? values.get("*") ?? 0;
  return (["br", "gzip"] as const)
    .filter((encoding) => weight(encoding) > 0)
    .sort((a, b) => weight(b) - weight(a));
}

export function precompressedAssets(webRoot: string): express.RequestHandler {
  const assetsRoot = path.resolve(path.join(webRoot, "assets"));

  return (req, res, next) => {
    if ((req.method !== "GET" && req.method !== "HEAD") || !req.path.startsWith("/assets/")) return next();

    let decoded: string;
    try {
      decoded = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    const file = path.resolve(assetsRoot, decoded.slice("/assets/".length));
    const relative = path.relative(assetsRoot, file);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return next();

    const encodings = acceptedEncodings(req.get("accept-encoding"));
    // The build keeps a compressed copy only where it came out smaller, so the client's next
    // choice is tried when its first is not on disk.
    void (async () => {
      for (const encoding of encodings) {
        const info = await stat(`${file}${SUFFIX[encoding]}`).catch(() => undefined);
        if (!info?.isFile()) continue;
        res.type(path.extname(file));
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Vary", "Accept-Encoding");
        res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
        // `root` keeps send's dotfile check to the asset's own name: the install path may
        // hold a dot-segment (e2e runs from `e2e/.tmp/app`).
        const name = `${relative}${SUFFIX[encoding]}`.split(path.sep).map(encodeURIComponent).join("/");
        res.sendFile(name, { root: assetsRoot }, (error) => { if (error) next(error); });
        return;
      }
      next();
    })();
  };
}
