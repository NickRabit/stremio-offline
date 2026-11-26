import { afterEach, beforeEach, expect, it } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useRovingTabs } from "./use-roving-tabs";

const IDS = ["one", "two", "three"] as const;

function Strip({ ids, selectedId }: { ids: readonly string[]; selectedId: string }) {
  const [selected, setSelected] = useState(selectedId);
  const tabProps = useRovingTabs(ids, selected, setSelected);
  return <div role="tablist">
    {ids.map((id) => <button key={id} type="button" role="tab" {...tabProps(id)}
      aria-selected={id === selected} onClick={() => setSelected(id)}>{id}</button>)}
  </div>;
}

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const tabs = () => host.querySelectorAll<HTMLButtonElement>('[role="tab"]');
const mount = async (selectedId = "one", ids: readonly string[] = IDS) => {
  await act(async () => { root.render(<Strip ids={ids} selectedId={selectedId}/>); });
};
const press = async (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => { document.activeElement!.dispatchEvent(event); });
  return event;
};

it("moves selection and focus to the next tab with ArrowRight", async () => {
  await mount();
  const buttons = tabs();
  await act(async () => { buttons[0].focus(); });
  await press("ArrowRight");
  expect(buttons[1].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[1]);
  expect(buttons[1].tabIndex).toBe(0);
  expect([...buttons].filter((button) => button.tabIndex === 0)).toHaveLength(1);
});

it("moves selection and focus to the previous tab with ArrowLeft", async () => {
  await mount("two");
  const buttons = tabs();
  await act(async () => { buttons[1].focus(); });
  await press("ArrowLeft");
  expect(buttons[0].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[0]);
  expect(buttons[0].tabIndex).toBe(0);
});

it("wraps at both ends", async () => {
  await mount();
  const buttons = tabs();
  await act(async () => { buttons[0].focus(); });
  await press("ArrowLeft");
  expect(buttons[2].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[2]);

  await press("ArrowRight");
  expect(buttons[0].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[0]);
});

it("moves to the first and last tabs with Home and End", async () => {
  await mount("two");
  const buttons = tabs();
  await act(async () => { buttons[1].focus(); });
  await press("End");
  expect(buttons[2].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[2]);
  expect(buttons[2].tabIndex).toBe(0);

  await press("Home");
  expect(buttons[0].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[0]);
  expect(buttons[0].tabIndex).toBe(0);
});

it("leaves an unrelated key alone and does not prevent it", async () => {
  await mount();
  const buttons = tabs();
  await act(async () => { buttons[0].focus(); });
  const event = await press("ArrowDown");
  expect(event.defaultPrevented).toBe(false);
  expect(buttons[0].getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(buttons[0]);
});

it("gives the first tab tabIndex 0 when the selected id is missing from ids", async () => {
  await mount("hidden");
  const buttons = tabs();
  expect(buttons[0].tabIndex).toBe(0);
  expect(buttons[1].tabIndex).toBe(-1);
  expect(buttons[2].tabIndex).toBe(-1);
});
