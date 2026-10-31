import type { ImageProxy } from "./images.js";

interface AddonArtworkView {
  manifest: {
    logo?: string | null;
    background?: unknown;
  };
}

/** Addon artwork sits on the provider's server as well, so it takes the same detour. */
export function withProxiedArtwork<T extends AddonArtworkView>(view: T, imageProxy: ImageProxy): T {
  const logo = typeof view.manifest.logo === "string" ? imageProxy.proxied(view.manifest.logo) : view.manifest.logo;
  const background = typeof view.manifest.background === "string"
    ? imageProxy.proxied(view.manifest.background)
    : view.manifest.background;
  return logo === view.manifest.logo && background === view.manifest.background
    ? view
    : { ...view, manifest: { ...view.manifest, logo, background } };
}
