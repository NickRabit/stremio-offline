import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SourceRows } from "./source-rows";
import { setLocale, t } from "./i18n";
import type { Stream } from "./types";

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

  it("badges a torrent and a playable row by the transport the catalogue names them by", () => {
    render([addonRow({ sourceId: "t1", kind: "torrent", playable: false, addonName: undefined }), addonRow({ sourceId: "p1", playable: false, addonName: undefined })]);
    expect([...host.querySelectorAll("i")].map((node) => node.textContent)).toEqual(["RD", "EXT"]);
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
