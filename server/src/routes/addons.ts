import type express from "express";
import { manifestChanged, refreshManifests, type RefreshOutcome } from "../addon-refresh.js";
import { allowedAddons, loadAddon, orderedForUser, orderFor } from "../addons.js";
import { AppError } from "../errors.js";
import { log } from "../logger.js";
import { assertStillAdmin } from "../roles.js";
import { normalizeDownloadSettings } from "../naming.js";
import { essentialAddon, publicAddon, publicAddonRestricted } from "../security.js";
import type { AddonRecord, AddonRole } from "../types.js";
import { bumpPermissions, emptyUserData, findUserById, usersToBump } from "../users.js";
import { asyncRoute, viewerOf, type RouteContext } from "./context.js";

export interface AddonsDeps extends RouteContext {
  storeRefreshed(outcomes: RefreshOutcome[]): Promise<void>;
  publicAddonView: (addon: AddonRecord) => ReturnType<typeof publicAddon> | ReturnType<typeof publicAddonRestricted>;
}

export function registerAddonsRoutes(app: express.Application, deps: AddonsDeps): void {
  const { store, currentUser, storeRefreshed, publicAddonView, stopContentAccess } = deps;

  const orderOf = (req: express.Request) =>
    orderFor(currentUser(req), (id) => store.userData(id).addonOrder);
  /** Keys the caller may see, in one copy each: an invisible key would record what
   *  somebody was once allowed, which is exactly what the overlay must not become. */
  const visibleOrder = (value: unknown, visible: Set<string>): string[] => {
    if (!Array.isArray(value)) throw new AppError("The order has to be a list of addon keys.", "err.invalidRequest", 400);
    const order: string[] = [];
    for (const entry of value) {
      const key = String(entry);
      if (visible.has(key) && !order.includes(key)) order.push(key);
    }
    return order;
  };

  /** What the caller may use. An administrator sees the switched-off ones too, because the
   *  switch is theirs; an ordinary account has no switch, so a disabled addon there is an
   *  entry it cannot use, cannot fix and cannot remove -- it reads as something broken, and
   *  the count beside it promises more than the account has. */
  app.get("/api/addons", (req, res) => {
    const user = currentUser(req);
    const visible = allowedAddons(store.addons(), viewerOf(user));
    const usable = user && user.role !== "admin" ? visible.filter((addon) => addon.enabled) : visible;
    res.json(orderedForUser(usable, orderOf(req)).map(publicAddonView));
  });
  // A person's own priority. Every account may set it; it never touches the global order,
  // which stays the administrator's `move` below.
  app.put("/api/addons/order", asyncRoute(async (req, res) => {
    const viewer = viewerOf(currentUser(req));
    const order = visibleOrder(req.body?.order, new Set(allowedAddons(store.addons(), viewer).map((addon) => addon.key)));
    await store.update((state) => {
      const data = state.userData?.[viewer.id] ?? emptyUserData();
      data.addonOrder = order;
      state.userData = { ...(state.userData ?? {}), [viewer.id]: data };
    });
    res.status(204).end();
  }));
  app.post("/api/addons", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
    const role = (["catalog", "source", "both"].includes(req.body.role) ? req.body.role : "both") as AddonRole;
    const addon = await loadAddon(String(req.body.url ?? ""), role);
    if (store.addons().some((item) => item.manifest.id === addon.manifest.id && item.manifestUrl === addon.manifestUrl)) throw new AppError("This manifest is already added.", "err.manifestExists");
    // Fetching the manifest takes long enough for the gate's answer to go stale.
    await store.update((state) => { assertStillAdmin(state.users ?? [], actor!); state.addons.push(addon); });
    res.status(201).json(publicAddonView(addon));
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
    // The record is gone, so nothing can be played or saved from it again: what is already
    // running on it is cut, for every account at once.
    if (existing) await stopContentAccess({ addonKey: existing.key });
    res.status(204).end();
  }));
  // The full record including the token-bearing address. The interface hides it elsewhere; handing it out here is deliberate.
  app.get("/api/addons/:key/export", asyncRoute(async (req, res) => {
    const addon = store.addons().find((a) => a.key === req.params.key);
    if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
    res.json({ manifestUrl: addon.manifestUrl, role: addon.role, enabled: addon.enabled, globalSearch: addon.globalSearch, addedAt: addon.addedAt, downloadSettings: addon.downloadSettings, manifest: addon.manifest });
  }));
  app.post("/api/addons/refresh", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
    const outcomes = await refreshManifests(store.addons(), loadAddon);
    assertStillAdmin(store.users(), actor);
    await storeRefreshed(outcomes);
    res.json({
      changed: outcomes.filter((outcome) => outcome.changed).length,
      failed: outcomes.filter((outcome) => outcome.error).length,
      addons: store.addons().map(publicAddonView),
    });
  }));
  app.post("/api/addons/:key/refresh", asyncRoute(async (req, res) => {
    const actorOfRefresh = currentUser(req);
    const existing = store.addons().find((a) => a.key === req.params.key);
    if (!existing) throw new AppError("The addon was not found.", "err.addonNotFound");
    // The error travels to the interface as it is: a single refresh was asked for by
    // hand, so whoever pressed the button wants to know why the addon did not answer.
    const loaded = await loadAddon(existing.manifestUrl, existing.role);
    // Read before the write: the store hands out the live record, so applying the
    // refresh replaces the manifest this variable points at.
    const previousVersion = existing.manifest.version;
    const changed = manifestChanged(existing.manifest, loaded.manifest);
    assertStillAdmin(store.users(), actorOfRefresh);
    await storeRefreshed([{ key: existing.key, name: loaded.manifest.name, previousVersion, version: loaded.manifest.version, changed, manifest: loaded.manifest }]);
    res.json({ addon: publicAddonView(store.addons().find((a) => a.key === existing.key)!), changed, previousVersion, version: loaded.manifest.version });
  }));
  app.patch("/api/addons/:key", asyncRoute(async (req, res) => {
    const actor = currentUser(req);
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
    let allowedUsers: string[] | undefined;
    if (req.body.allowedUsers !== undefined) {
      if (!Array.isArray(req.body.allowedUsers)) throw new AppError("The list of accounts has to be an array.", "err.invalidRequest", 400);
      const wanted = new Set<string>();
      for (const value of req.body.allowedUsers) {
        const id = String(value);
        const user = findUserById(store.users(), id);
        if (!user) throw new AppError("That account does not exist.", "err.unknownUser");
        // An administrator uses every addon by role, so their id in the list would read as
        // though removing it took the addon away.
        if (user.role === "admin") throw new AppError("An administrator can already use every addon.", "err.adminAlwaysUsesAddons");
        wanted.add(id);
      }
      allowedUsers = [...wanted];
    }
    // The settings are validated before the write: the mutator changes state in place, so
    // an exception halfway through would leave changes in memory that are never persisted.
    // It also rejects a nonsensical request before fetching a manifest for it.
    const downloadSettings = req.body.downloadSettings === undefined ? undefined : normalizeDownloadSettings(req.body.downloadSettings, store.libraries());
    const reloaded = url && url !== existing.manifestUrl ? await loadAddon(url, role) : undefined;
    // Read before the write: the mutator changes the live record, and the sweep needs the
    // switch as it was on either side of it.
    const before = { enabled: existing.enabled, allowedUsers: existing.allowedUsers };
    // A grant edit is a permission change on both sides: the accounts just removed are the
    // ones whose in-flight requests most need to fail their re-check.
    const bumped = allowedUsers === undefined ? [] : usersToBump(before.allowedUsers, allowedUsers);
    await store.update((state) => {
      assertStillAdmin(state.users ?? [], actor!);
      const addon = state.addons.find((a) => a.key === req.params.key);
      if (!addon) throw new AppError("The addon was not found.", "err.addonNotFound");
      if (typeof req.body.enabled === "boolean") addon.enabled = req.body.enabled;
      if (typeof req.body.globalSearch === "boolean") addon.globalSearch = req.body.globalSearch;
      if (typeof req.body.showInContinueWatching === "boolean") addon.showInContinueWatching = req.body.showInContinueWatching;
      if (downloadSettings) addon.downloadSettings = downloadSettings;
      if (allowedUsers) addon.allowedUsers = allowedUsers;
      if (bumped.length) state.users = bumpPermissions(state.users ?? [], bumped);
      addon.role = role;
      if (reloaded) { addon.manifestUrl = reloaded.manifestUrl; addon.manifest = reloaded.manifest; }
    });
    const after = store.addons().find((a) => a.key === req.params.key);
    if (after) {
      // Switching it off takes it from everybody, which no counter records.
      if (before.enabled && !after.enabled) await stopContentAccess({ addonKey: after.key });
      else {
        const removed = (before.allowedUsers ?? []).filter((id) => !(after.allowedUsers ?? []).includes(id));
        for (const userId of removed) await stopContentAccess({ userId, addonKey: after.key });
      }
    }
    if (reloaded) log("INFO", "Addon reconfigured", { name: reloaded.manifest.name, role });
    res.json(publicAddonView(store.addons().find((a) => a.key === req.params.key)!));
  }));
}
