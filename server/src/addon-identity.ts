import { createHash } from "node:crypto";
import type { AddonRecord } from "./types.js";

export const ADDON_IDENTITY_PATTERN = /^[0-9a-f]{64}$/;

export const isAddonIdentity = (value: unknown): value is string =>
  typeof value === "string" && ADDON_IDENTITY_PATTERN.test(value);

export const addonIdentity = (
  addon: Pick<AddonRecord, "manifestUrl" | "manifest" | "role">,
): string =>
  createHash("sha256").update(JSON.stringify([
    addon.manifestUrl,
    addon.manifest.id,
    addon.manifest.version,
    addon.role,
    addon.manifest.resources ?? [],
  ]), "utf8").digest("hex");

export const applyAddonManifestRefreshes = (
  addons: AddonRecord[],
  outcomes: ReadonlyArray<{
    key: string;
    changed: boolean;
    manifest?: AddonRecord["manifest"];
  }>,
): string[] => {
  const identityChanged: string[] = [];
  for (const outcome of outcomes) {
    const addon = addons.find((item) => item.key === outcome.key);
    if (!outcome.changed || !outcome.manifest || !addon) continue;
    const previousIdentity = addonIdentity(addon);
    addon.manifest = outcome.manifest;
    if (addonIdentity(addon) !== previousIdentity) identityChanged.push(addon.key);
  }
  return identityChanged;
};
