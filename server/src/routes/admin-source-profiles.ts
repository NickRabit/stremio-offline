import { randomUUID } from "node:crypto";
import type express from "express";
import { AppError } from "../errors.js";
import { ForbiddenError } from "../roles.js";
import {
  declaresStream,
  RULE_PRESETS,
} from "../source-profiles.js";
import { parseDownloadRules, type DownloadRules } from "../download-rules.js";
import type { State, StoredSourceProfile } from "../store.js";
import { asyncRoute, type RouteContext } from "./context.js";

export interface AdminSourceProfilesDeps extends RouteContext {
  newProfileId?: () => string;
}

export interface AdminSourceProfilesHandlers {
  list: express.RequestHandler;
  create: express.RequestHandler;
  duplicate: express.RequestHandler;
  update: express.RequestHandler;
  delete: express.RequestHandler;
}

const PRESET_IDS: ReadonlySet<string> = new Set(RULE_PRESETS.map((preset) => preset.id));

const invalidProfile = (): AppError =>
  new AppError("The profile settings are not valid.", "err.sourceProfileInvalid", 400);

const builtInProfile = (): AppError =>
  new AppError("This built-in profile cannot be changed that way.", "err.sourceProfileBuiltIn", 400);

const profileUnavailable = (): AppError =>
  new AppError("That source profile is unavailable.", "err.sourceProfileUnavailable", 404);

const staleRevision = (): AppError =>
  new AppError("This source profile revision is no longer available.", "err.sourceProfileRevisionStale", 409);

const assertAdmin = (user: ReturnType<RouteContext["currentUser"]>) => {
  if (!user || user.disabled || user.role !== "admin") throw new ForbiddenError();
  return user;
};

const plainObject = (
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalidProfile();
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)
    || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
    || !("value" in Object.getOwnPropertyDescriptor(value, key)!))
    || required.some((key) => !Object.hasOwn(value, key))) {
    throw invalidProfile();
  }
  return value as Record<string, unknown>;
};

const profileName = (value: unknown): string => {
  if (typeof value !== "string") throw invalidProfile();
  const name = value.trim();
  if (name.length < 1 || name.length > 60) throw invalidProfile();
  return name;
};

const nameIsTaken = (
  profiles: readonly StoredSourceProfile[],
  name: string,
  exceptId?: string,
): boolean => profiles.some((profile) => profile.id !== exceptId
  && profile.name !== undefined
  && profile.name.toLowerCase() === name.toLowerCase());

const assertNameAvailable = (
  profiles: readonly StoredSourceProfile[],
  name: string,
  exceptId?: string,
): void => {
  if (nameIsTaken(profiles, name, exceptId)) {
    throw new AppError("A profile with this name already exists.", "err.sourceProfileNameTaken", 409);
  }
};

const rulesFor = (value: unknown): DownloadRules => {
  try {
    return parseDownloadRules(value);
  } catch {
    throw invalidProfile();
  }
};

const assertAddonKeys = (
  state: State,
  rules: DownloadRules,
): void => {
  const keys = [
    ...(rules.addons.scope === "all" ? [] : rules.addons.scope.selected),
    ...(rules.addons.order === "viewer" ? [] : rules.addons.order.explicit),
  ];
  const streamAddons = new Set(
    state.addons.filter(declaresStream).map((addon) => addon.key),
  );
  if (keys.some((key) => !streamAddons.has(key))) throw invalidProfile();
};

const freshProfileId = (
  state: State,
  newProfileId: () => string,
): string => {
  const used = new Set([
    ...(state.sourceProfiles ?? []).map((profile) => profile.id),
    ...(state.deletedSourceProfileIds ?? []),
  ]);
  let id = newProfileId();
  while (used.has(id)) id = newProfileId();
  return id;
};

const copyProfile = (profile: StoredSourceProfile): StoredSourceProfile =>
  structuredClone(profile);

const timestamp = (): string => new Date().toISOString();

export function registerAdminSourceProfilesRoutes(
  app: express.Application,
  deps: AdminSourceProfilesDeps,
): AdminSourceProfilesHandlers {
  const newProfileId = deps.newProfileId ?? randomUUID;

  const list = asyncRoute(async (req, res) => {
    assertAdmin(deps.currentUser(req));
    res.setHeader("cache-control", "private, no-store");
    res.json({ profiles: deps.store.sourceProfiles().map(copyProfile) });
  });

  const create = asyncRoute(async (req, res) => {
    assertAdmin(deps.currentUser(req));
    let created: StoredSourceProfile | undefined;
    await deps.store.update((state) => {
      const body = plainObject(req.body, ["name", "rules"]);
      const name = profileName(body.name);
      const profiles = state.sourceProfiles ?? [];
      assertNameAvailable(profiles, name);
      const parameters = rulesFor(body.rules);
      assertAddonKeys(state, parameters);

      const now = timestamp();
      created = {
        id: freshProfileId(state, newProfileId),
        revision: 1,
        template: "rules",
        name,
        parameters: structuredClone(parameters),
        createdAt: now,
        updatedAt: now,
      };
      state.sourceProfiles = [...profiles, created];
    });
    res.status(201).json(copyProfile(created!));
  });

  const duplicate = asyncRoute(async (req, res) => {
    assertAdmin(deps.currentUser(req));
    let duplicated: StoredSourceProfile | undefined;
    await deps.store.update((state) => {
      const profiles = state.sourceProfiles ?? [];
      const source = profiles.find((profile) => profile.id === req.params.id);
      if (!source) throw profileUnavailable();
      if (source.template !== "rules" || source.parameters === undefined) throw builtInProfile();
      const body = plainObject(req.body, ["name"]);
      const name = profileName(body.name);
      assertNameAvailable(profiles, name);

      const now = timestamp();
      duplicated = {
        id: freshProfileId(state, newProfileId),
        revision: 1,
        template: source.template,
        name,
        ...(source.parameters === undefined
          ? {}
          : { parameters: structuredClone(source.parameters) }),
        createdAt: now,
        updatedAt: now,
      };
      state.sourceProfiles = [...profiles, duplicated];
    });
    res.status(201).json(copyProfile(duplicated!));
  });

  const update = asyncRoute(async (req, res) => {
    assertAdmin(deps.currentUser(req));
    let updated: StoredSourceProfile | undefined;
    await deps.store.update((state) => {
      const profile = (state.sourceProfiles ?? []).find((candidate) => candidate.id === req.params.id);
      if (!profile) throw profileUnavailable();
      const body = plainObject(req.body, ["revision"], ["name", "rules"]);
      if (body.revision !== profile.revision) throw staleRevision();
      if (PRESET_IDS.has(profile.id) && Object.hasOwn(body, "name")) throw builtInProfile();

      let name = profile.name;
      if (Object.hasOwn(body, "name")) {
        name = profileName(body.name);
        assertNameAvailable(state.sourceProfiles ?? [], name, profile.id);
      }

      let parameters = profile.parameters;
      if (Object.hasOwn(body, "rules")) {
        if (profile.template !== "rules") throw builtInProfile();
        parameters = rulesFor(body.rules);
        assertAddonKeys(state, parameters);
      }

      if (!Number.isSafeInteger(profile.revision + 1)) throw invalidProfile();
      profile.revision += 1;
      if (name !== undefined) profile.name = name;
      if (parameters !== undefined) profile.parameters = structuredClone(parameters);
      profile.updatedAt = timestamp();
      updated = copyProfile(profile);
    });
    res.json(copyProfile(updated!));
  });

  const remove = asyncRoute(async (req, res) => {
    assertAdmin(deps.currentUser(req));
    await deps.store.update((state) => {
      const profiles = state.sourceProfiles ?? [];
      const index = profiles.findIndex((profile) => profile.id === req.params.id);
      if (index < 0) throw profileUnavailable();
      const profile = profiles[index]!;
      const revision = typeof req.query.revision === "string" && /^\d+$/.test(req.query.revision)
        ? Number(req.query.revision)
        : NaN;
      if (revision !== profile.revision) throw staleRevision();
      if (PRESET_IDS.has(profile.id)) throw builtInProfile();

      state.sourceProfiles = profiles.filter((candidate) => candidate.id !== profile.id);
      state.deletedSourceProfileIds = [...(state.deletedSourceProfileIds ?? []), profile.id];
      for (const data of Object.values(state.userData ?? {})) {
        if (data.prefs.downloadSourceProfile === profile.id) delete data.prefs.downloadSourceProfile;
        if (data.prefs.followSourceProfile === profile.id) delete data.prefs.followSourceProfile;
      }
    });
    res.status(204).end();
  });

  const handlers = { list, create, duplicate, update, delete: remove };
  app.get("/api/admin/source-profiles", handlers.list);
  app.post("/api/admin/source-profiles", handlers.create);
  app.post("/api/admin/source-profiles/:id/duplicate", handlers.duplicate);
  app.patch("/api/admin/source-profiles/:id", handlers.update);
  app.delete("/api/admin/source-profiles/:id", handlers.delete);
  return handlers;
}
