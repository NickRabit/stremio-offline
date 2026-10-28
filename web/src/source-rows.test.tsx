import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SourceFilters, SourceRows } from "./source-rows";
import { setLocale, t } from "./i18n";
import type { SourceProfile, Stream } from "./types";

const addonRow = (over: Partial<Stream> = {}): Stream => ({
  sourceId: "a1", kind: "remote", playable: true, name: "FullHD", addonKey: "cineshare", addonName: "Cineshare",
  behaviorHints: { filename: "A.Very.Long.Release.Name.2026.2160p.WEB-DL.DDP.mkv" }, ...over,
});

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  setLocale("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** The catalogue's own list: no badge of its own, no probe, the rows as the addon answered them. */
const render = (rows: Stream[], badgeOf?: (stream: Stream) => string) =>
  act(() => root.render(<SourceRows rows={rows} selected={null} onSelect={() => {}} {...(badgeOf ? { badgeOf } : {})}/>));
const row = () => host.querySelector("button")!;

describe("SourceRows", () => {
  it("labels an addon row exactly as the catalogue does: its transport, its own name, its addon caption", () => {
    render([addonRow()]);
    expect(row().querySelector("i")!.textContent).toBe("HTTP");
    expect(row().querySelector("strong")!.textContent).toBe("FullHD");
    expect(row().querySelector("small")!.textContent).toBe("Cineshare");
    // A long file name is metadata an addon volunteered; it never displaces the quality label.
    expect(row().textContent).not.toContain("A.Very.Long");
  });

  it("leads a local copy with its file name and tags it as the library's own", () => {
    // A caller's own badge dresses a media server's rows; a file that is already here keeps the
    // library's own chip and the folder it sits in.
    render([addonRow({ kind: "library", localPath: "Films/Heat.mkv", libraryName: "Films", addonKey: undefined, addonName: undefined, name: "Heat 1080p" })], () => "Emby");
    expect(row().querySelector("i")!.textContent).toContain("Local");
    expect(row().querySelector("strong")!.textContent).toBe("A.Very.Long.Release.Name.2026.2160p.WEB-DL.DDP.mkv");
    expect(row().querySelector("small")!.textContent).toBe("Films");
  });

  it("names a row the source said nothing about with a translated fallback, never a literal", () => {
    render([addonRow({ name: undefined, title: undefined, description: undefined, behaviorHints: undefined, addonName: undefined })]);
    expect(row().querySelector("strong")!.textContent).toBe(t("tv.version"));
  });

  it("explains the reasons a source breaks the default rules", () => {
    act(() => root.render(<SourceRows rows={[addonRow({ rules: {
      balanced: {
        profileId: "balanced", status: "breaks", rank: [2],
        reasons: ["language", "resolutionLow", "subtitles", "size", "provider", "torrent", "codec", "hdr"],
      },
    } })]} selected={null} onSelect={() => {}} ruleId="balanced"/>));
    expect(row().textContent).toContain(t("sources.ruleBreaks", {
      reasons: [
        t("sources.ruleReason.language"),
        t("sources.ruleReason.resolutionLow"),
        t("sources.ruleReason.subtitles"),
        t("sources.ruleReason.size"),
        t("sources.ruleReason.provider"),
        t("sources.ruleReason.torrent"),
        t("sources.ruleReason.codec"),
        t("sources.ruleReason.hdr"),
      ].join(", "),
    }));
  });

  it("does not add a rule note to a source that meets them", () => {
    act(() => root.render(<SourceRows rows={[addonRow({ rules: {
      balanced: { profileId: "balanced", status: "meets", reasons: [], rank: [0] },
    } })]} selected={null} onSelect={() => {}} ruleId="balanced"/>));
    expect(row().textContent).not.toContain(t("sources.ruleBreaks", { reasons: "" }));
  });

  it("shows the video facts the rules evaluated", () => {
    render([addonRow({ videoFacts: { heightPixels: 2160, codec: "hevc", range: "dolbyVision" } })]);
    const facts = row().querySelector(`[title="${t("sources.videoFactsHint")}"]`);
    expect(facts?.textContent).toBe("2160p · HEVC · Dolby Vision");
  });

  it("shows no video facts line when the server sent none", () => {
    render([addonRow()]);
    expect(row().querySelector(`[title="${t("sources.videoFactsHint")}"]`)).toBeNull();
  });

  it("badges a torrent and a playable row by the transport the catalogue names them by", () => {
    render([addonRow({ sourceId: "t1", kind: "torrent", playable: false, addonName: undefined }), addonRow({ sourceId: "p1", playable: false, addonName: undefined })]);
    expect([...host.querySelectorAll("i")].map((node) => node.textContent)).toEqual(["RD", "EXT"]);
  });

  it("marks listed remote audio as in the file, keeps a guess labelled, and leaves addons unchanged", () => {
    const remote = addonRow({
      sourceId: "remote-1",
      name: "Remote Rules Fixture S01E01",
      provider: "jellyfin",
      remoteItem: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "v1", progressKey: "key" },
      audioLanguages: ["cs", "en"],
    });
    const guessed = addonRow({
      sourceId: "remote-2",
      name: "Remote Rules Fixture S01E01 CZ",
      provider: "jellyfin",
      remoteItem: { libraryId: "rlib_a", itemId: "2", mediaSourceId: "v2", progressKey: "key-2" },
      audioLanguages: ["cs"],
      audioLanguagesGuessed: true,
    });
    const addon = addonRow({ name: "Remote Rules Fixture S01E01", title: "CZ dabing" });
    render([remote, guessed, addon]);

    const [inFile, guess, unchangedAddon] = [...host.querySelectorAll("button")];
    const inFileBadges = [...inFile!.querySelectorAll(".lang-badge")];
    expect(inFileBadges).toHaveLength(2);
    expect(inFileBadges.map((badge) => badge.textContent)).toEqual(["CZ", "EN"]);
    expect(inFileBadges.every((badge) => badge.getAttribute("title") === t("sources.audioInFile"))).toBe(true);
    const guessedBadges = [...guess!.querySelectorAll(".lang-badge")];
    expect(guessedBadges.map((badge) => badge.textContent)).toEqual(["CZ"]);
    expect(guessedBadges[0]!.getAttribute("title")).toBe(t("sources.languageGuess"));
    const addonBadges = [...unchangedAddon!.querySelectorAll(".lang-badge")];
    expect(addonBadges.map((badge) => badge.textContent)).toEqual(["CZ"]);
    expect(addonBadges[0]!.getAttribute("title")).toBe(t("sources.languageGuess"));
  });

  it("keeps the focus on the same source when an earlier group inserts its rows", async () => {
    const named = (id: string, name: string): Stream => addonRow({ sourceId: id, name, addonKey: undefined, addonName: undefined, behaviorHints: undefined });
    const rows = [named("a", "Alpha"), named("b", "Beta"), named("c", "Gamma")];
    await act(async () => root.render(<SourceRows rows={rows} selected={rows[2]!} onSelect={() => {}}/>));
    const third = host.querySelectorAll("button")[2]!;
    third.focus();
    expect(document.activeElement).toBe(third);
    // A later answer arrives with its own rows ahead of the list the viewer is walking: the row
    // under the focus must still be the source it was, never whichever row took its index.
    await act(async () => root.render(<SourceRows rows={[named("x", "Inserted"), ...rows]} selected={rows[2]!} onSelect={() => {}}/>));
    expect(host.querySelectorAll("button")).toHaveLength(4);
    expect(document.activeElement).toBe(host.querySelectorAll("button")[3]);
    expect(document.activeElement!.textContent).toContain("Gamma");
  });

  it("lists one row when two groups answer with the very same source, and keeps two libraries apart", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const twice = addonRow({ sourceId: "dup", name: "Twice" });
    // Two copies sharing one source id belong to two libraries and are two rows; a source repeated
    // by its own identity is one, so React never sees one key twice.
    const mine = { ...addonRow({ sourceId: "shared", name: "Mine" }), provider: "emby" as const, remoteItem: { libraryId: "rlib_a", itemId: "1", mediaSourceId: "ms1", progressKey: "k" } };
    const other = { ...addonRow({ sourceId: "shared", name: "Other" }), provider: "jellyfin" as const, remoteItem: { libraryId: "rlib_b", itemId: "1", mediaSourceId: "ms1", progressKey: "k" } };
    await act(async () => root.render(<SourceRows rows={[twice, { ...twice }, mine, other]} selected={null} onSelect={() => {}}/>));
    expect([...host.querySelectorAll("button")].map((node) => node.querySelector("strong")!.textContent)).toEqual(["Twice", "Mine", "Other"]);
    expect(errors.mock.calls.flat().join(" ")).not.toContain("same key");
  });
});

describe("SourceFilters", () => {
  const field = (value: string) => ({
    value, onChange: () => {},
    all: { label: "All", count: 5 },
    options: [
      { value: "pleasure", label: "My Pleasure $$$", count: 5 },
      { value: "remote:films", label: "Jellyfin · Films", count: 0 },
      { value: "remote:series", label: "Jellyfin · Series", count: 0 },
    ],
  });
  const options = () => [...host.querySelector("select")!.querySelectorAll("option")].map((option) => option.textContent);
  const sortOptions = () => {
    const selects = host.querySelectorAll("select");
    return [...selects[selects.length - 1]!.querySelectorAll("option")].map((option) => option.textContent);
  };
  const profiles: SourceProfile[] = [
    { id: "balanced", nameKey: "rules.preset.balanced", template: "rules", revision: 1, operations: ["play"], policy: {} as SourceProfile["policy"] },
    { id: "best", nameKey: "rules.preset.best", template: "rules", revision: 1, operations: ["play"], policy: {} as SourceProfile["policy"] },
  ];

  it("offers no place that answered nothing", () => {
    act(() => root.render(<SourceFilters visible addon={field("")} sort={{ value: "rule:balanced", onChange: () => {} }}/>));
    expect(options()).toEqual(["All (5)", "My Pleasure $$$ (5)"]);
  });

  it("keeps an empty place that is the current choice", () => {
    act(() => root.render(<SourceFilters visible addon={field("remote:series")} sort={{ value: "rule:balanced", onChange: () => {} }}/>));
    expect(options()).toEqual(["All (5)", "My Pleasure $$$ (5)", "Jellyfin · Series (0)"]);
  });

  it("lists rule options before the fixed source orders", () => {
    act(() => root.render(<SourceFilters visible addon={field("")} profiles={profiles} sort={{ value: "rule:balanced", onChange: () => {} }}/>));
    expect(sortOptions()).toEqual([
      t("rules.preset.balanced"),
      t("rules.preset.best"),
      t("sources.sortLargest"),
      t("sources.sortSmallest"),
      t("sources.sortAddon"),
    ]);
  });

  it("does not repeat the stored fixed order while profiles are loading", () => {
    act(() => root.render(<SourceFilters visible addon={field("")} sort={{ value: "size-asc", onChange: () => {} }}/>));
    expect(sortOptions()).toEqual([
      t("sources.sortLargest"),
      t("sources.sortSmallest"),
      t("sources.sortAddon"),
    ]);
  });
});
