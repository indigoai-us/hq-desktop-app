// @vitest-environment happy-dom
// QA-105: with hundreds of projects the picker draws a bounded list and the
// search narrows the rest.
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import LinkPicker from "./LinkPicker.svelte";

let component: Record<string, unknown> | null = null;
afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
});

const projects = Array.from({ length: 632 }, (_, i) => ({
  id: `p-${i}`,
  name: `project ${i}`,
  company: "acme",
  description: "",
  status: "active",
  prdPath: `p-${i}/prd.json`,
}));

describe("LinkPicker row cap (QA-105)", () => {
  it("renders at most 50 rows of 632 and says how to find the rest", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(LinkPicker, {
      target: host,
      props: { projects: projects as never, objectives: [], onclose: () => {}, onlink: () => {} },
    });
    flushSync();
    const rows = host.querySelectorAll(".list:first-of-type .row, .list .row.hq-contain-row");
    expect(rows.length).toBeLessThanOrEqual(50);
    expect(host.querySelector("[data-testid='link-picker-more']")?.textContent).toContain("of 632");
    const search = host.querySelector<HTMLInputElement>("input.search")!;
    search.value = "project 631";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect([...host.querySelectorAll(".row.hq-contain-row")].map((r) => r.textContent)).toEqual(["project 631"]);
  });
});
