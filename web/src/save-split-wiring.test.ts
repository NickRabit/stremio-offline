import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const compact = (value: string) => value.replace(/\s+/g, "");

const app = source("./App.tsx");
const between = (value: string, start: string, end: string) => {
  const from = value.indexOf(start);
  const to = value.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return value.slice(from, to);
};

describe("save split wiring", () => {
  it("queues the selected catalogue source from the main action and opens the rules from its arrow", () => {
    const catalogue = between(app, "<CatalogueTitleDetail", "saveSupported=");
    expect(compact(catalogue)).toContain(
      "onSaveToLibrary={(stream,effective)=>voidqueueCatalogueStream(effective,stream)}",
    );
    expect(compact(catalogue)).toContain(
      "onSaveElsewhere={(stream,effective)=>openCatalogueDownload(effective,stream,detailSourcePicked)}",
    );
  });

  it("restores the panel's direct main save, keeps its remote target branch, and opens the rules from its arrow", () => {
    const primary = between(app, "const primarySave =", "const downloadStreamToDevice =");
    expect(compact(primary)).toContain(
      "if(selectedStream&&isRemoteStream(selectedStream)&&sourceTargetRule(selectedStream)===undefined){setSaveTargetOpen(true);return;}",
    );
    expect(compact(primary)).toContain("voidenqueue()");

    const panel = between(app, "selectedLocalPath ? <button onClick={() => revealLibraryCopy", "onDownloadToDevice");
    expect(compact(panel)).toContain("onClick={primarySave}");
    expect(compact(panel)).toContain("onClick={()=>openSingleDownload()}");
    expect(compact(panel)).not.toContain("onClick={()=>setSaveTargetOpen(true)}");
  });

  it("hands the selected source to the rules as the exact first choice", () => {
    const single = between(app, "const openSingleDownload =", "const primarySave =");
    expect(single).toContain("exactSource: { stream: selectedStream");
    expect(single).toContain("preferred: pickedRef.current");

    const catalogue = between(app, "const openCatalogueDownload =", "const queueCatalogueStream =");
    expect(catalogue).toContain("exactSource: { stream, label: streamLabel(stream), preferred }");
  });

  it("routes a library title with a bulk target to the rules and leaves the others on Save elsewhere", () => {
    const alternative = between(app, "const openAlternativeSave =", "const submitAlternativeSave =");
    expect(compact(alternative)).toContain(
      "if(request.catalogueDetail){openCatalogueDownload(request.catalogueDetail,request.stream,false);return;}",
    );
    expect(compact(alternative)).toContain(
      "if(request.choose||(isRemoteStream(request.stream)&&sourceTargetRule(request.stream)===undefined)){setAlternativeSave(save);return;}",
    );
    expect(compact(app)).toContain(
      "onCatalogueDownload={(stream,detail)=>openCatalogueDownload(detail,stream,false)}",
    );
  });
});
