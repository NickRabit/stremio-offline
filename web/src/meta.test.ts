import { describe, expect, it } from "vitest";
import { localizedDownloadTitle, mergeMetaDetail } from "./meta";

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
});
