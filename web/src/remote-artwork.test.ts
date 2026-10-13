import { expect, it } from "vitest";
import { remoteDetailArtwork } from "./remote-artwork";
const path = "/api/remote-libraries/rlib_a/items/item-1/artwork/Primary";
it("requests the fixed detail variant and preserves the image tag", () => {
  expect(remoteDetailArtwork(`${path}?tag=a%2Bb`)).toBe(`${path}?tag=a%2Bb&size=detail`);
  expect(remoteDetailArtwork(path)).toBe(`${path}?size=detail`);
  expect(remoteDetailArtwork(`${path}?size=detail`)).toBe(`${path}?size=detail`);
});
it("leaves other image sources and existing backdrop requests alone", () => {
  for (const url of [undefined, "/poster.jpg", "https://example.com" + path, path.replace("Primary", "Backdrop")]) {
    expect(remoteDetailArtwork(url)).toBe(url);
  }
});
