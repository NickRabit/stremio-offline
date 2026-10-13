import { beforeEach, describe, expect, it } from "vitest";
import { catalogueGalleryImages, detailGallery, mergeGallery, posterAndWide, GALLERY_LIMIT, type GalleryImage } from "./gallery-images";
import { setLocale } from "./i18n";
import type { Meta } from "./types";

const image = (url: string, over: Partial<GalleryImage> = {}): GalleryImage =>
  ({ url, label: "Poster", shape: "poster", kind: "poster", ...over });

beforeEach(() => { setLocale("en"); });

describe("catalogueGalleryImages", () => {
  it("reads the poster, the wide artwork, the stills and the video thumbnails in order", () => {
    const meta: Meta = {
      id: "tt1", type: "movie", name: "One", poster: "/poster.jpg", background: "/back.jpg", logo: "/logo.png",
      images: ["/one.jpg", { url: "/two.jpg" }],
      screenshots: ["/three.jpg"],
      videos: [{ thumbnail: "/thumb.jpg" }, { thumbnail: "/named.jpg", title: "Scene" }],
    };
    const images = catalogueGalleryImages(meta);
    expect(images.map((entry) => entry.url)).toEqual([
      "/poster.jpg", "/back.jpg", "/logo.png", "/one.jpg", "/two.jpg", "/three.jpg", "/thumb.jpg", "/named.jpg",
    ]);
    expect(images.find((entry) => entry.url === "/poster.jpg")).toMatchObject({ shape: "poster", kind: "poster", label: "Poster" });
    expect(images.find((entry) => entry.url === "/back.jpg")).toMatchObject({ shape: "wide", kind: "background", label: "Background" });
    expect(images.find((entry) => entry.url === "/one.jpg")).toMatchObject({ shape: "wide", kind: "still", label: "Still 1" });
    expect(images.find((entry) => entry.url === "/named.jpg")).toMatchObject({ kind: "still", label: "Scene" });
  });

  it("drops a repeated URL and caps at the shared limit", () => {
    const stills = Array.from({ length: 30 }, (_, index) => `/s-${index}.jpg`);
    const meta: Meta = { id: "tt1", type: "movie", name: "One", poster: "/poster.jpg", background: "/poster.jpg", screenshots: stills };
    const images = catalogueGalleryImages(meta);
    expect(images).toHaveLength(GALLERY_LIMIT);
    expect(new Set(images.map((entry) => entry.url)).size).toBe(GALLERY_LIMIT);
  });

  it("answers nothing without metadata", () => {
    expect(catalogueGalleryImages(null)).toEqual([]);
    expect(catalogueGalleryImages(undefined)).toEqual([]);
  });
});

describe("mergeGallery", () => {
  it("keeps the first source's order and drops a URL another source already holds", () => {
    const merged = mergeGallery([image("/poster.jpg"), image("/shared.jpg")], [image("/shared.jpg"), image("/later.jpg")]);
    expect(merged.map((entry) => entry.url)).toEqual(["/poster.jpg", "/shared.jpg", "/later.jpg"]);
  });

  it("caps the merged gallery at the shared limit", () => {
    const primary = Array.from({ length: 12 }, (_, index) => image(`/a-${index}.jpg`));
    const secondary = Array.from({ length: 12 }, (_, index) => image(`/b-${index}.jpg`));
    expect(mergeGallery(primary, secondary)).toHaveLength(GALLERY_LIMIT);
  });
});

describe("detailGallery", () => {
  it("puts the metadata first and the stored downloads after, deduplicated", () => {
    const stored = [
      { url: "/saved-poster.jpg", kind: "poster" as const, shape: "poster" as const },
      { url: "/poster.jpg", kind: "poster" as const, shape: "poster" as const },
      { url: "/saved-still.jpg", kind: "still" as const, shape: "wide" as const },
    ];
    const merged = detailGallery(stored, [image("/poster.jpg"), image("/back.jpg", { shape: "wide", kind: "background" })]);
    expect(merged.map((entry) => entry.url)).toEqual(["/poster.jpg", "/back.jpg", "/saved-poster.jpg", "/saved-still.jpg"]);
    expect(merged.find((entry) => entry.url === "/saved-still.jpg")).toMatchObject({ label: "Still 1", kind: "still" });
  });

  it("hands back the metadata untouched when the stored gallery is empty", () => {
    const metadata = [image("/poster.jpg"), image("/back.jpg", { shape: "wide", kind: "background" })];
    expect(detailGallery([], metadata)).toEqual(metadata);
  });
});

describe("posterAndWide", () => {
  it("shapes whichever of the two the provider gave", () => {
    expect(posterAndWide("/p.jpg", "/w.jpg").map((entry) => entry.url)).toEqual(["/p.jpg", "/w.jpg"]);
    expect(posterAndWide(undefined, "/w.jpg").map((entry) => [entry.url, entry.kind])).toEqual([["/w.jpg", "background"]]);
    expect(posterAndWide(undefined, undefined)).toEqual([]);
  });
});
