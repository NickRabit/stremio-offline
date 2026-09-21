import { describe, expect, it } from "vitest";
import { gridArt, localizedDownloadTitle, mergeMetaDetail } from "./meta";
import type { Meta } from "./types";

describe("mergeMetaDetail", () => {
  it("keeps the localized catalog title when detailed metadata uses another language", () => {
    const merged = mergeMetaDetail(
      { id: "tt0086831", type: "series", name: "Jistě, pane premiére", poster: "catalog.jpg" },
      { id: "tt0086831", type: "series", name: "Yes, Prime Minister", description: "Description", poster: "detail.jpg" },
    );

    expect(merged).toEqual({
      id: "tt0086831",
      type: "series",
      name: "Jistě, pane premiére",
      description: "Description",
      poster: "detail.jpg",
    });
  });

  it("uses a detailed title only when its language matches the download setting", () => {
    const summary = { id: "tt0086831", type: "series", name: "Jistě, pane premiére" };
    expect(localizedDownloadTitle(summary, { ...summary, name: "Yes, Prime Minister", nameLanguage: "en" }, "en")).toBe("Yes, Prime Minister");
    expect(localizedDownloadTitle(summary, { ...summary, name: "Yes, Prime Minister", nameLanguage: "en" }, "cs")).toBe("Jistě, pane premiére");
  });

  it("keeps the catalog id when the metadata addon answers with its own id scheme", () => {
    const merged = mergeMetaDetail(
      { id: "tt0090257", type: "movie", name: "Vesničko má středisková" },
      { id: "tmdb:31410", type: "movie", name: "My Sweet Little Village", description: "…" },
    );

    expect(merged.id).toBe("tt0090257");
    expect(merged.name).toBe("Vesničko má středisková");
    expect(merged.description).toBe("…");
  });

  it("falls back to the detailed type when the catalog item has none", () => {
    const merged = mergeMetaDetail(
      { id: "tt0090257", type: "", name: "Vesničko má středisková" },
      { id: "tmdb:31410", type: "series", name: "My Sweet Little Village" },
    );

    expect(merged.type).toBe("series");
  });
});

describe("gridArt", () => {
  it("takes the pictures from the catalogue row, not from the metadata detail", () => {
    expect(gridArt({ poster: "row.jpg", background: "row-wide.jpg" } as Meta, { poster: "meta.jpg", background: "meta-wide.jpg" } as Meta))
      .toEqual({ poster: "row.jpg", background: "row-wide.jpg" });
  });

  it("gives the wide variant the poster when the row has no background of its own", () => {
    expect(gridArt({ poster: "row.jpg" } as Meta, { background: "meta-wide.jpg" } as Meta))
      .toEqual({ poster: "row.jpg", background: "row.jpg" });
  });

  it("falls back to the detail where the row has nothing, as a resume row has not", () => {
    expect(gridArt(null, { poster: "meta.jpg", background: "meta-wide.jpg" } as Meta))
      .toEqual({ poster: "meta.jpg", background: "meta.jpg" });
    expect(gridArt(null, { background: "meta-wide.jpg" } as Meta))
      .toEqual({ poster: undefined, background: "meta-wide.jpg" });
  });
});
