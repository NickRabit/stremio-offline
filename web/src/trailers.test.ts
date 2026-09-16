import { expect, it } from "vitest";
import { isYouTubeId, trailerAction, trailerEmbedUrl, trailerWatchUrl } from "./trailers";
import type { Trailer } from "./types";

const trailer = (over: Partial<Trailer> = {}): Trailer => ({ youtubeId: "kM8I4yDQS5w", provider: "cinemeta", ...over });

it("accepts a YouTube id and nothing shaped like a URL", () => {
  expect(isYouTubeId("kM8I4yDQS5w")).toBe(true);
  expect(isYouTubeId("kM8I4yDQS5")).toBe(false);
  expect(isYouTubeId("kM8I4yDQS5ww")).toBe(false);
  expect(isYouTubeId("https://www.youtube.com/watch?v=kM8I4yDQS5w")).toBe(false);
  expect(isYouTubeId("../../etc/passwd")).toBe(false);
  expect(isYouTubeId(undefined)).toBe(false);
});

it("frames the privacy-enhanced embed and never the watch page", () => {
  expect(trailerEmbedUrl("kM8I4yDQS5w")).toBe("https://www.youtube-nocookie.com/embed/kM8I4yDQS5w?autoplay=1&rel=0");
  expect(trailerWatchUrl("kM8I4yDQS5w")).toBe("https://www.youtube.com/watch?v=kM8I4yDQS5w");
});

it("offers the overlay while the instance is not locked down, and a YouTube tab when it is", () => {
  expect(trailerAction(trailer(), false)).toEqual({ kind: "overlay", trailer: trailer() });
  expect(trailerAction(trailer(), true)).toEqual({ kind: "external", trailer: trailer(), href: "https://www.youtube.com/watch?v=kM8I4yDQS5w" });
});

it("shows no action at all without a usable trailer", () => {
  expect(trailerAction(null, false)).toBeNull();
  expect(trailerAction(undefined, true)).toBeNull();
  expect(trailerAction(trailer({ youtubeId: "not-an-id" }), false), "an id the server would never send is not framed").toBeNull();
});
