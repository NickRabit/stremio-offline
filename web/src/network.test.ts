import { describe, expect, it } from "vitest";
import { networkHint } from "./network";

describe("networkHint", () => {
  it("sends nothing where the browser has no Network Information API", () => {
    expect(networkHint(undefined)).toBeUndefined();
    expect(networkHint({})).toBeUndefined();
  });

  it("passes on what the API reports and drops an unmeasured downlink", () => {
    expect(networkHint({ saveData: false, effectiveType: "4g", downlink: 0, type: "cellular" }))
      .toEqual({ saveData: false, effectiveType: "4g", type: "cellular" });
    expect(networkHint({ effectiveType: "3g", downlink: 1.4 })).toEqual({ effectiveType: "3g", downlink: 1.4 });
  });
});
