import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { api } from "./api";
import { Downloads } from "./DownloadsPage";
import { setLocale } from "./i18n";
import type { Download, DownloadWindowState, DownloadsViewPrefs } from "./types";

const prefs: DownloadsViewPrefs = {
  sort: "order",
  direction: "asc",
  status: "",
  dateField: "createdAt",
  pageSize: 20,
};

const job = (over: Partial<Download> = {}): Download => ({
  id: "job-1",
  title: "Film",
  status: "queued",
  target: "Film/Film.mkv",
  received: 0,
  speed: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pending: false,
  order: 0,
  ...over,
});

const closed: DownloadWindowState = {
  start: "01:00",
  end: "07:00",
  open: false,
  timeZone: "Europe/Prague",
};

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
  vi.restoreAllMocks();
});

const render = async (jobs: Download[], window: DownloadWindowState | null, refresh = vi.fn(() => Promise.resolve()), speedLimitMbps: number | null = null) => {
  await act(async () => {
    root.render(<Downloads
      jobs={jobs}
      deviceTransfers={[]}
      libraries={[]}
      halt={null}
      queueWindow={window}
      speedLimitMbps={speedLimitMbps}
      admin={false}
      refresh={refresh}
      onError={vi.fn()}
      onReveal={vi.fn()}
      prefs={prefs}
      onPrefs={vi.fn()}
    />);
  });
  return refresh;
};

describe("Downloads download window", () => {
  it("shows the closed window and marks waiting rows", async () => {
    await render([
      job(),
      job({ id: "job-2", title: "Paused", status: "paused", pauseReason: "schedule", order: 1 }),
      job({ id: "job-3", title: "Exempt", windowExempt: true, order: 2 }),
    ], closed);

    expect(host.textContent).toContain("Downloads run only between 01:00 and 07:00 (Europe/Prague).");
    const rows = [...host.querySelectorAll<HTMLElement>(".download-row")];
    const text = (title: string) => rows.find((row) => row.textContent?.includes(title))!;
    expect(text("Film").textContent).toContain("Waits for the download window.");
    expect(text("Paused").textContent).toContain("Waits for the download window.");
    expect(text("Exempt").textContent).not.toContain("Waits for the download window.");
    expect(text("Film").querySelector(`button[title="Download now"]`)).not.toBeNull();
    expect(text("Paused").querySelector(`button[title="Download now"]`)).not.toBeNull();
    expect(text("Exempt").querySelector(`button[title="Download now"]`)).toBeNull();
  });

  it("offers Download now for a schedule pause even after the window opens", async () => {
    await render([job({ status: "paused", pauseReason: "schedule" })], { ...closed, open: true });
    expect(host.textContent).toContain("Waits for the download window.");
    expect(host.querySelector(`button[title="${"Download now"}"]`)).not.toBeNull();
    expect(host.querySelector(".queue-halt")).toBeNull();
  });

  it("calls the now action and refreshes the queue", async () => {
    const now = vi.spyOn(api, "downloadAction").mockResolvedValue(undefined);
    const refresh = await render([job()], closed);
    const button = host.querySelector<HTMLButtonElement>(`button[title="Download now"]`)!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(now).toHaveBeenCalledWith("job-1", "now");
    expect(refresh).toHaveBeenCalledOnce();
  });
});

describe("Downloads speed limit", () => {
  it("shows the shared cap while one is set", async () => {
    await render([], null, vi.fn(() => Promise.resolve()), 20);
    expect(host.textContent).toContain("Download speed is limited to 20 Mbit/s.");
  });

  it("says nothing while downloads are not limited", async () => {
    await render([], null);
    expect(host.textContent).not.toContain("Download speed is limited");
  });
});
