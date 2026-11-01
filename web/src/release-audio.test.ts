import { describe, expect, it } from "vitest";
import { setLocale } from "./i18n";
import { audioFactsText, audioFormat } from "./release-audio";

describe("audioFormat", () => {
  const cases: Array<[string, string | undefined]> = [
    ["Movie.2019.UHD.BluRay.DTS-HD.MA.7.1-GROUP", "DTS-HD MA 7.1"],
    ["Show.S01E01.1080p.DDP5.1.Atmos.mkv", "DD+ 5.1 Atmos"],
    ["Film.2020.WEB-DL.AAC2.0", "AAC 2.0"],
    ["Title.TrueHD.7.1.Atmos", "TrueHD 7.1 Atmos"],
    ["Old.DVDRip.AC3", "DD"],
    ["Plain.1080p.x264.mkv", undefined],
    ["Concert.FLAC.2.0", "FLAC 2.0"],
    ["Podcast.Opus", "Opus"],
    ["Film.DTS-HD.5.1", "DTS-HD 5.1"],
    ["Film.DTS.5.1", "DTS 5.1"],
    ["Film.DD5.1", "DD 5.1"],
    ["Film.DD+", "DD+"],
    ["Film.EAC3.5.1", "DD+ 5.1"],
    ["Film.E-AC-3", "DD+"],
    ["Film.DTS-HD MA 7.1", "DTS-HD MA 7.1"],
    ["Film.DTSHDMA.7.1", "DTS-HD MA 7.1"],
    ["truehd.atmos", "TrueHD Atmos"],
    ["Film.AAC.5.1", "AAC 5.1"],
    ["", undefined],
    ["Just.7.1.channels", undefined],
  ];

  it.each(cases)("reads %s as %s", (name, expected) => {
    expect(audioFormat(name)).toBe(expected);
  });

  it("ignores a missing name", () => {
    expect(audioFormat(undefined)).toBeUndefined();
    expect(audioFormat(null)).toBeUndefined();
  });
});

describe("audioFactsText", () => {
  it("names a read track the way a release name would", () => {
    expect(audioFactsText({ codec: "eac3", channels: 6 })).toBe("DD+ 5.1");
    expect(audioFactsText({ codec: "aac", channels: 2 })).toBe("AAC 2.0");
    expect(audioFactsText({ codec: "truehd" })).toBe("TrueHD");
    expect(audioFactsText({ channels: 8 })).toBe("7.1");
  });

  it("counts an unusual layout in channels and says nothing without facts", () => {
    setLocale("en");
    expect(audioFactsText({ codec: "flac", channels: 3 })).toBe("FLAC 3 ch");
    expect(audioFactsText({})).toBeUndefined();
    expect(audioFactsText(undefined)).toBeUndefined();
  });
});
