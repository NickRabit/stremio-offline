import { afterEach, describe, expect, it, vi } from "vitest";

const order: string[] = [];
vi.mock("./api", () => ({ startStartupGets: () => { order.push("startup"); } }));
vi.mock("./App", () => ({ App: () => null }));
vi.mock("./hls-loader", () => ({ loadHls: () => Promise.resolve() }));
vi.mock("./i18n", () => ({ i18nReady: new Promise<void>((resolve) => { order.push("i18n"); setTimeout(resolve, 0); }) }));
vi.mock("react-dom/client", () => ({ createRoot: () => ({ render: () => { order.push("render"); } }) }));

afterEach(() => { document.body.innerHTML = ""; });

describe("main", () => {
  it("starts the start-up requests before the first render", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    await import("./main");
    await vi.waitFor(() => expect(order).toContain("render"));
    expect(order).toContain("startup");
    expect(order.indexOf("startup")).toBeLessThan(order.indexOf("render"));
  });
});
