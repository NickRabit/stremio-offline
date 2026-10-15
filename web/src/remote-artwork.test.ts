import { expect, it } from "vitest";
import { remoteDetailArtwork, remoteTileArtwork } from "./remote-artwork";
const path = "/api/remote-libraries/rlib_a/items/item-1/artwork/Primary";
const backdrop = path.replace("Primary", "Backdrop");
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
it("asks for the listing width of a remote backdrop and preserves the image tag", () => {
  expect(remoteTileArtwork(`${backdrop}?tag=a%2Bb`)).toBe(`${backdrop}?tag=a%2Bb&size=tile`);
  expect(remoteTileArtwork(backdrop)).toBe(`${backdrop}?size=tile`);
  expect(remoteTileArtwork(`${backdrop}?size=tile`)).toBe(`${backdrop}?size=tile`);
  expect(remoteTileArtwork(`${backdrop}?size=detail`)).toBe(`${backdrop}?size=tile`);
});
it("leaves a poster and anything that is not remote artwork alone", () => {
  for (const url of [undefined, "/poster.jpg", "https://example.com" + backdrop, path, `${path}?tag=a`]) {
    expect(remoteTileArtwork(url)).toBe(url);
  }
});
