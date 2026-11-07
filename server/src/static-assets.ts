import express from "express";
import path from "node:path";
import { stat } from "node:fs/promises";

export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

function acceptedEncodings(header: string | undefined): (encoding: "br" | "gzip") => boolean {
  if (!header) return () => false;
  const values = new Map<string, number>();
  for (const part of header.split(",")) {
    const [rawName, ...parameters] = part.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) continue;
    const q = parameters.find((parameter) => parameter.trim().toLowerCase().startsWith("q="));
    const value = q === undefined ? 1 : Number(q.split("=")[1]);
    values.set(name, Number.isFinite(value) && value > 0 ? value : 0);
  }
  const allowed = (encoding: "br" | "gzip") => {
    const explicit = values.get(encoding);
    if (explicit !== undefined) return explicit > 0;
    return (values.get("*") ?? 0) > 0;
  };
  return allowed;
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

    const allowed = acceptedEncodings(req.get("accept-encoding"));
    const encoding = allowed("br") ? "br" : allowed("gzip") ? "gzip" : undefined;
    if (!encoding) return next();

    const suffix = encoding === "br" ? ".br" : ".gz";
    const compressed = `${file}${suffix}`;
    void stat(compressed).then((info) => {
      if (!info.isFile()) return next();
      res.type(path.extname(file));
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("Cache-Control", ASSET_CACHE_CONTROL);
      // `root` keeps send's dotfile check to the asset's own name: the install path may
      // hold a dot-segment (e2e runs from `e2e/.tmp/app`).
      const name = `${relative}${suffix}`.split(path.sep).map(encodeURIComponent).join("/");
      res.sendFile(name, { root: assetsRoot }, (error) => { if (error) next(error); });
    }, () => next());
  };
}
