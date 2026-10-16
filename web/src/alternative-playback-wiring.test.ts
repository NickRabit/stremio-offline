import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The alternative player and its save dialog live in the shell component, which is not mounted in
 *  a unit test: the guards below read the source so the ordering they depend on cannot creep back. */
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const appSource = source("./App.tsx");
/** The alternative player's own opening tag and its callbacks. */
const alternativePlayer = appSource.slice(appSource.indexOf("{alternative && <Player open "));
const alternativeBlock = alternativePlayer.slice(0, alternativePlayer.indexOf("{libraryManagerOpen &&"));

describe("the alternative player's save and close wiring", () => {
  it("offers the exact row that is playing, a native copy included, through the destination dialog", () => {
    const download = alternativeBlock.slice(alternativeBlock.indexOf("onDownload={async () => {"), alternativeBlock.indexOf("onDeviceDownload={"));
    // The queue accepts the row as it is: a copy of another media server is no longer refused here.
    expect(download).toContain("openAlternativeSave({ stream: alternative.stream");
    expect(download).not.toContain("remoteItem");
    // Saving the copy down to the device stays refused, as it is for every native source.
    const device = alternativeBlock.slice(alternativeBlock.indexOf("onDeviceDownload={async () => {"), alternativeBlock.indexOf("onProgressSaved="));
    expect(device).toContain("if (alternative.stream.remoteItem) return false;");
  });

  it("refreshes only when the played row's own final write landed, never on close", () => {
    expect(alternativeBlock).toContain("onProgressSaved={(key) => {");
    // The row captured at the click decides, and every personal store is redrawn: the rule itself
    // is behavioural in source-progress.test.ts, the wiring here only hands it the captured owner.
    expect(alternativeBlock).toContain("alternativeProgressSaved(alternative.owner, key, {");
    expect(alternativeBlock).toContain("personal: refreshPersonal,");
    expect(appSource).toContain("JSON.stringify([session?.username, view, localDetail?.item.path, remoteOpen, playerOpen])");
    expect(appSource).toContain("const scope = ++alternativeScopeRef.current.generation;");
    expect(alternativeBlock).toContain("{ captured: alternative.scope, current: alternativeScopeRef.current.generation }");
    // The close hands the overlay back and nothing else: the write is still out at that moment.
    const close = alternativeBlock.slice(alternativeBlock.indexOf("onClose={() => {"));
    expect(close.slice(0, close.indexOf("}}/>")).replace(/\s+/g, "")).toBe("onClose={()=>{setAlternative(null);");
  });

  it("reuses the one save request helper for the detail rows and the player", () => {
    // The row's own destination is resolved by the server; the helper is what names one when the
    // viewer asks for the dialog, and the dialog is the only thing that reads it back.
    expect(appSource).toContain("const save = alternativeSaveRequest(request.title, request.stream, request.media, request.kind);");
    expect(appSource).toContain("if (request.choose || (isRemoteStream(request.stream) && sourceTargetRule(request.stream) === undefined)) {");
    expect(appSource).toContain("rule={alternativeSave.rule ?? addons.find((addon) => addon.key === alternativeSave.stream.addonKey)?.downloadSettings}");
  });
});
