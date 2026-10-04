import assert from "node:assert/strict";
import test from "node:test";
import { hasDolbyVisionEnhancementLayer, looksUnreachable, pickVariant, playlistArgsFrom } from "./probe.js";

test("the picky segment options are passed only to a build that has them", () => {
  assert.deepEqual(
    playlistArgsFrom("  -allowed_segment_extensions <string>\n  -extension_picky   <boolean>  reject unknown extensions"),
    ["-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0"],
  );
  // An older FFmpeg dies on an option it does not know, so it must be left out entirely.
  assert.deepEqual(playlistArgsFrom("  -allowed_extensions <string>"), ["-allowed_extensions", "ALL"]);
  assert.deepEqual(playlistArgsFrom(""), ["-allowed_extensions", "ALL"]);
});

test("a dead connection or a server error is recognised as unreachable", () => {
  assert.equal(looksUnreachable("tcp://host:443: Connection refused"), true);
  assert.equal(looksUnreachable("Server returned 404 Not Found"), true);
  assert.equal(looksUnreachable("Server returned 500 Internal Server Error"), true);
  assert.equal(looksUnreachable("Failed to resolve hostname host: Name or service not known"), true);
  assert.equal(looksUnreachable("Connection timed out"), true);
});

test("a stream the source just failed to decode is not treated as unreachable", () => {
  assert.equal(looksUnreachable("Invalid data found when processing input"), false);
  assert.equal(looksUnreachable(""), false);
});

test("Dolby Vision enhancement layer is recognised from ffprobe side data", () => {
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ side_data_type: "DOVI configuration record", el_present_flag: 1 }],
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ name: "Dolby Vision enhancement-layer HEVC configuration" }],
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    tags: { title: "Dolby Vision enhancement-layer HEVC configuration" },
  }), true);
  assert.equal(hasDolbyVisionEnhancementLayer({
    side_data_list: [{ side_data_type: "DOVI configuration record", el_present_flag: 0 }],
  }), false);
  assert.equal(hasDolbyVisionEnhancementLayer({ side_data_list: [] }), false);
});

test("an HLS master is read as one rendition: the tallest, with its own audio", () => {
  const rendition = (index: number, height: number, bitrate: number) => [
    { index, codec_type: "video", codec_name: "h264", height, tags: { variant_bitrate: String(bitrate) } },
    { index: index + 1, codec_type: "audio", codec_name: "aac", tags: { variant_bitrate: String(bitrate) } },
    { index: index + 2, codec_type: "data", tags: { variant_bitrate: String(bitrate) } },
  ];
  const ladder = [...rendition(0, 144, 105384), ...rendition(3, 720, 819686), ...rendition(6, 1080, 2151645), ...rendition(9, 2160, 11504545)];
  const picked = pickVariant(ladder);
  assert.equal(picked?.video.index, 9, "the 4K, not the 144p FFmpeg lists first");
  assert.equal(picked?.audio?.index, 10, "the audio of that same rendition");
  assert.equal(pickVariant(rendition(0, 720, 1)), undefined, "a single rendition needs no choosing");
  assert.equal(pickVariant([{ index: 0, codec_type: "video", height: 1080 }, { index: 1, codec_type: "video", height: 720 }]), undefined, "a file, not a playlist");
});
