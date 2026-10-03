// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";
import { mount, tick, unmount } from "svelte";

import MoreCompaniesPopover from "./MoreCompaniesPopover.svelte";
import type { MoreCompany } from "./more-companies.js";

const companies: MoreCompany[] = [
  { uid: "co_in", name: "Indigo", slug: "indigo", liveCount: 4 },
  { uid: "co_lr", name: "LiveRecover", slug: "liverecover", liveCount: 1 },
  { uid: "co_sa", name: "Sender Agency", slug: "sender", liveCount: 0 },
  { uid: "co_a", name: "Alpha", slug: "alpha", liveCount: 0 },
  { uid: "co_b", name: "Beta", slug: "beta", liveCount: 0 },
  { uid: "co_c", name: "Gamma", slug: "gamma", liveCount: 0 },
  { uid: "co_d", name: "Delta", slug: "delta", liveCount: 0 },
  { uid: "co_new", name: "Harbor", slug: "harbor", liveCount: 0 },
];

const six = ["co_in", "co_lr", "co_a", "co_b", "co_c", "co_d"];

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

function mountPopover(
  props: Partial<{
    pinnedIds: string[];
    onopen: (company: MoreCompany) => void;
    onpins: (ids: string[]) => void;
    onnewcompany: () => void;
  }> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(MoreCompaniesPopover, {
    target: host,
    props: {
      companies,
      pinnedIds: props.pinnedIds ?? ["co_in", "co_lr"],
      recentIds: ["co_sa"],
      onopen: props.onopen,
      onpins: props.onpins,
      onnewcompany: props.onnewcompany,
    },
  });
}

describe("More companies popover (US-005)", () => {
  it("paints pinned, recent, and all counts from the cached list", async () => {
    mountPopover();
    await tick();
    const text = host.textContent ?? "";
    expect(text).toContain("Pinned · 2 of 6");
    expect(text).toContain("Recent");
    expect(text).toContain("All · 8");
    expect(text).toContain("Indigo");
    expect(text).toContain("4");
    expect(host.innerHTML).not.toContain("co_in");
    expect(host.querySelector("[data-testid='more-new-company']")).toBeTruthy();
  });

  it("filters by slug on the client", async () => {
    mountPopover();
    await tick();
    const input = host.querySelector("input");
    expect(input).toBeTruthy();
    input!.value = "harbor";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(host.textContent).toContain("Harbor");
    expect(host.textContent).not.toContain("Indigo");
    expect(host.textContent).toContain("All · 1");
  });

  it("opens an unpinned company without pinning it", async () => {
    const opened: string[] = [];
    const pins: string[][] = [];
    mountPopover({
      onopen: (company) => opened.push(company.uid),
      onpins: (ids) => pins.push(ids),
    });
    await tick();
    const row = [...host.querySelectorAll(".row")].find((el) =>
      el.textContent?.includes("Sender Agency"),
    );
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(opened).toEqual(["co_sa"]);
    expect(pins).toEqual([]);
  });

  it("asks which of the six tiles to replace", async () => {
    const pins: string[][] = [];
    mountPopover({ pinnedIds: six, onpins: (ids) => pins.push(ids) });
    await tick();
    const pin = host.querySelector("[aria-label='Pin Harbor']");
    pin?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(host.textContent).toContain("Replace a pinned tile");
    expect(pins).toEqual([]);
    const indigo = [...host.querySelectorAll("[data-testid='more-replace-list'] .row")].find(
      (el) => el.textContent?.includes("Indigo"),
    );
    indigo?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await tick();
    expect(pins[0]).toEqual(["co_new", "co_lr", "co_a", "co_b", "co_c", "co_d"]);
    expect(pins[0]).toHaveLength(6);
  });

  it("starts a new company from the footer", async () => {
    let created = 0;
    mountPopover({ onnewcompany: () => (created += 1) });
    await tick();
    host
      .querySelector("[data-testid='more-new-company']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(created).toBe(1);
  });
});
