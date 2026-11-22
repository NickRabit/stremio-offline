import { afterEach, beforeEach, expect, it } from "vitest";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sameJson } from "./App";

const initial = [{ id: "job-1", received: 20, total: 100 }];

function Probe({ next, observe }: { next: typeof initial; observe(state: typeof initial): void }) {
  const [downloads, setDownloads] = useState(initial);
  observe(downloads);
  useEffect(() => {
    setDownloads((previous) => sameJson(previous, next) ? previous : next);
  }, [next]);
  return null;
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

it("an equal downloads snapshot keeps the previous state identity", async () => {
  let current = initial;
  const observe = (state: typeof initial) => { current = state; };
  await act(async () => { root.render(<Probe next={initial} observe={observe} />); });
  const first = current;

  await act(async () => { root.render(<Probe next={initial.map((job) => ({ ...job }))} observe={observe} />); });
  expect(current).toBe(first);

  const changed = [{ ...initial[0]!, received: 40 }];
  await act(async () => { root.render(<Probe next={changed} observe={observe} />); });
  expect(current).not.toBe(first);
  expect(current).toEqual(changed);
});
