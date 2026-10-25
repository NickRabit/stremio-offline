import type express from "express";
import { ResourceError } from "../media-resources.js";
import { sourceProfilesForViewer, viewerOfProfileAccount } from "../source-profiles.js";
import type { RouteContext } from "./context.js";

export type SourceProfilesDeps = RouteContext;

export function registerSourceProfilesRoutes(app: express.Application, deps: SourceProfilesDeps): void {
  app.get("/api/source-profiles", (req, res) => {
    res.setHeader("cache-control", "private, no-store");
    const user = deps.currentUser(req);
    if (!user || user.disabled) throw new ResourceError(401, "AUTH_REQUIRED");

    res.json({
      profiles: sourceProfilesForViewer({
        viewer: viewerOfProfileAccount(user),
        addons: deps.store.addons(),
        libraries: deps.store.libraries(),
        remoteLibraries: deps.store.remoteLibraries(),
        mediaConnections: deps.store.mediaConnections(),
      }),
    });
  });
}
