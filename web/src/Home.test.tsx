import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Home } from "./Home";
import { setLocale } from "./i18n";
import type { Download } from "./types";

const at = "2026-01-01T00:00:00.000Z";
const job = (over: Partial<Download> & Pick<Download, "id">): Download => ({
  title: over.id, status: "queued", target: `${over.id}.mkv`, received: 0, speed: 0,
  createdAt: at, updatedAt: at, pending: false, order: 0, mine: true, ...over,
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

const render = async (jobs: Download[], onAction = vi.fn(async () => undefined), onShowDownloads = vi.fn()) => {
  await act(async () => {
    root.render(<Home jobs={jobs} libraries={[]} onShowDownloads={onShowDownloads} onAction={onAction} admin={false}/>);
  });
  return { onAction, onShowDownloads };
};

const cardButtons = () => [...host.querySelectorAll<HTMLDivElement>(".hq-card")].map((card) => [...card.querySelectorAll<HTMLButtonElement>("button")]);

describe("Home", () => {
  it("draws no row and shows the empty state when there is nothing to show", async () => {
    await render([job({ id: "done", status: "completed" }), job({ id: "theirs", mine: false })]);
    expect(host.querySelector(".home-row")).toBeNull();
    expect(host.querySelector(".empty")).not.toBeNull();
    expect(host.textContent).toContain("Nothing here yet");
  });

  it("draws the Downloads row when the account has jobs", async () => {
    await render([job({ id: "running", status: "downloading", total: 100, received: 50, speed: 1024 })]);
    expect(host.querySelector(".home-row")).not.toBeNull();
    expect(host.querySelector(".empty")).toBeNull();
    expect(host.textContent).toContain("Downloads");
    expect(host.querySelectorAll(".hq-card")).toHaveLength(1);
  });

  it("keeps the title and the action as sibling buttons", async () => {
    const { onShowDownloads } = await render([job({ id: "Duna", status: "downloading" })]);
    const [title, action] = cardButtons()[0]!;
    expect(title!.classList.contains("hq-title")).toBe(true);
    expect(title!.contains(action!)).toBe(false);
    expect(action!.contains(title!)).toBe(false);
    await act(async () => { title!.click(); });
    expect(onShowDownloads).toHaveBeenCalled();
  });

  it("calls onAction with the action the state names", async () => {
    const failed = job({ id: "failed", status: "failed" });
    const paused = job({ id: "paused", status: "paused", pauseReason: "user", order: 1 });
    const { onAction } = await render([failed, paused]);
    await act(async () => { cardButtons()[0]![1]!.click(); });
    expect(onAction).toHaveBeenCalledWith(failed, "retry");
    await act(async () => { cardButtons()[1]![1]!.click(); });
    expect(onAction).toHaveBeenCalledWith(paused, "resume");
  });

  it("opens the Downloads view for a job Home cannot repair", async () => {
    const blocked = job({ id: "blocked", status: "paused", pauseReason: "storage" });
    const { onAction, onShowDownloads } = await render([blocked]);
    await act(async () => { cardButtons()[0]![1]!.click(); });
    expect(onShowDownloads).toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(cardButtons()[0]![1]!.textContent).toContain("Open downloads");
  });

  it("disables only the card whose mutation is pending and restores it on failure", async () => {
    let rejectAction: (error: unknown) => void = () => undefined;
    const onAction = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectAction = reject; }));
    await render([job({ id: "a", status: "failed" }), job({ id: "b", status: "failed", order: 1 })], onAction);

    await act(async () => { cardButtons()[0]![1]!.click(); });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(cardButtons()[0]![1]!.disabled).toBe(true);
    expect(cardButtons()[1]![1]!.disabled).toBe(false);

    await act(async () => { rejectAction(new Error("the queue refused it")); });
    expect(cardButtons()[0]![1]!.disabled).toBe(false);
    expect(cardButtons()[1]![1]!.disabled).toBe(false);
  });
});
