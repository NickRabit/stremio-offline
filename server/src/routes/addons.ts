import type express from "express";
import { manifestChanged, refreshManifests, type RefreshOutcome } from "../addon-refresh.js";
import { loadAddon } from "../addons.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { normalizeDownloadSettings } from "../naming.js";
import { essentialAddon, publicAddon, publicAddonRestricted } from "../security.js";
import type { AddonRecord, AddonRole } from "../types.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface AddonsDeps extends RouteContext {
  storeRefreshed(outcomes: RefreshOutcome[]): Promise<void>;
  publicAddonView: (addon: AddonRecord) => ReturnType<typeof publicAddon> | ReturnType<typeof publicAddonRestricted>;
}

export function registerAddonsRoutes(app: express.Application, deps: AddonsDeps): void {
  const { store, storeRefreshed, publicAddonView } = deps;

  app.get("/api/addons", (_req, res) => res.json(store.addons().map(publicAddonView)));
  app.post("/api/addons", asyncRoute(async (req, res) => {
    const role = (["catalog", "source", "both"].includes(req.body.role) ? req.body.role : "both") as AddonRole;
    const addon = await loadAddon(String(req.body.url ?? ""), role);
    if (store.addons().some((item) => item.manifest.id === addon.manifest.id && item.manifestUrl === addon.manifestUrl)) throw new AppError("This manifest is already added.", "err.manifestExists");
    await store.update((state) => state.addons.push(addon)); res.status(201).json(publicAddonView(addon));
  }));
  // The order of addons is also their priority when sources are ranked.
  app.post("/api/addons/:key/move", asyncRoute(async (req, res) => {
    const direction = Number(req.body.direction) < 0 ? -1 : 1;
    await store.update((state) => {
      const index = state.addons.findIndex((addon) => addon.key === req.params.key);
      if (index < 0) throw new AppError("The addon was not found.", "err.addonNotFound");
      const next = Math.max(0, Math.min(state.addons.length - 1, index + direction));
      if (next === index) return;
      const [addon] = state.addons.splice(index, 1);
      state.addons.splice(next, 0, addon);
    });
    res.status(204).end();
  }));
  app.delete("/api/addons/:key", asyncRoute(async (req, res) => {
    const existing = store.addons().find((a) => a.key === req.params.key);
    if (existing && essentialAddon(existing)) throw new AppError("Cinemeta provides the library metadata and cannot be removed.", "err.essentialAddon");
    await store.update((state) => { state.addons = state.addons.filter((a) => a.key !== req.params.key); });
    res.status(204).end();
  }));
  // The full record including the token-bearing address. The interface hides it elsewhere; handing it out here is deliberate.
  app.get("/api/addons/:key/export", asyncRoute(async (req, res) => {
    const addon = store.addons().find((a) => a.key === req.params.key);
    if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
    res.json({ manifestUrl: addon.manifestUrl, role: addon.role, enabled: addon.enabled, globalSearch: addon.globalSearch, addedAt: addon.addedAt, downloadSettings: addon.downloadSettings, manifest: addon.manifest });
  }));
  app.post("/api/addons/refresh", asyncRoute(async (_req, res) => {
    const outcomes = await refreshManifests(store.addons(), loadAddon);
    await storeRefreshed(outcomes);
    res.json({
      changed: outcomes.filter((outcome) => outcome.changed).length,
      failed: outcomes.filter((outcome) => outcome.error).length,
      addons: store.addons().map(publicAddonView),
    });
  }));
  app.post("/api/addons/:key/refresh", asyncRoute(async (req, res) => {
    const existing = store.addons().find((a) => a.key === req.params.key);
    if (!existing) throw new AppError("The addon was not found.", "err.addonNotFound");
    // The error travels to the interface as it is: a single refresh was asked for by
    // hand, so whoever pressed the button wants to know why the addon did not answer.
    const loaded = await loadAddon(existing.manifestUrl, existing.role);
    // Read before the write: the store hands out the live record, so applying the
    // refresh replaces the manifest this variable points at.
    const previousVersion = existing.manifest.version;
    const changed = manifestChanged(existing.manifest, loaded.manifest);
    await storeRefreshed([{ key: existing.key, name: loaded.manifest.name, previousVersion, version: loaded.manifest.version, changed, manifest: loaded.manifest }]);
    res.json({ addon: publicAddonView(store.addons().find((a) => a.key === existing.key)!), changed, previousVersion, version: loaded.manifest.version });
  }));
  app.patch("/api/addons/:key", asyncRoute(async (req, res) => {
    const existing = store.addons().find((a) => a.key === req.params.key);
    if (!existing) throw new AppError("The addon was not found.", "err.addonNotFound");
    const role = ["catalog", "source", "both"].includes(req.body.role) ? req.body.role as AddonRole : existing.role;
    // Switching it off, or down to a stream-only role, would take the metadata with it.
    if (essentialAddon(existing) && (req.body.enabled === false || role === "source")) {
      throw new AppError("Cinemeta provides the library metadata and cannot be switched off.", "err.essentialAddon");
    }
    // A different address means reloading the manifest. The key, the order and the save
    // rules stay, so a reconfigured addon need not be removed and added again.
    const url = req.body.url === undefined ? undefined : String(req.body.url).trim();
    // The settings are validated before the write: the mutator changes state in place, so
    // an exception halfway through would leave changes in memory that are never persisted.
    // It also rejects a nonsensical request before fetching a manifest for it.
    const downloadSettings = req.body.downloadSettings === undefined ? undefined : normalizeDownloadSettings(req.body.downloadSettings, store.libraries());
    const reloaded = url && url !== existing.manifestUrl ? await loadAddon(url, role) : undefined;
    await store.update((state) => {
      const addon = state.addons.find((a) => a.key === req.params.key);
      if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
      if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled;
      if (typeof req.body.globalSearch === "boolean") addon.globalSearch = req.body.globalSearch;
      if (typeof req.body.showInContinueWatching === "boolean") addon.showInContinueWatching = req.body.showInContinueWatching;
      if (downloadSettings) addon.downloadSettings = downloadSettings;
      addon.role = role;
      if (reloaded) { addon.manifestUrl = reloaded.manifestUrl; addon.manifest = reloaded.manifest; }
    });
    if (reloaded) log("INFO", "Addon reconfigured", { name: reloaded.manifest.name, role });
    res.json(publicAddonView(store.addons().find((a) => a.key === req.params.key)!));
  }));
}
