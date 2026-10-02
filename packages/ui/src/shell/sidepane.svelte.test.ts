// @vitest-environment happy-dom


import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import SidepaneProbe from "./SidepaneProbe.test.svelte";
import SidepaneList from "./SidepaneList.svelte";
import {
  COMPANY_SETTINGS_ROW,
  SIDEPANE_ROW_HEIGHT,
  SIDEPANE_VIRTUALIZE_THRESHOLD,
  SidepaneScrollMemory,
  atlasSidepaneModel,
  companySidepaneModel,
  flattenSections,
  sidepaneModelKey,
  sidepaneModelKind,
  windowRange,
} from "./sidepane-models.js";

// jsdom has no layout: give elements a writable scrollTop clamped by nothing.
beforeAll(() => {
  const store = new WeakMap<Element, number>();
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return store.get(this) ?? 0;
    },
    set(this: HTMLElement, v: number) {
      store.set(this, v);
    },
  });
});

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

describe("sidepane models (console-rail US-006)", () => {
  it("keys Home, Company, and Atlas per destination", () => {
    expect(sidepaneModelKey({ tenantCompanyId: null })).toBe("home");
    expect(sidepaneModelKey({ tenantCompanyId: "  " })).toBe("home");
    expect(sidepaneModelKey({ tenantCompanyId: "co_a" })).toBe("company:co_a");
    expect(sidepaneModelKey({ tenantCompanyId: "co_a", atlasActive: true })).toBe("atlas:co_a");
    expect(sidepaneModelKind("home")).toBe("home");
    expect(sidepaneModelKind("company:co_a")).toBe("company");
    expect(sidepaneModelKind("atlas:co_a")).toBe("atlas");
  });

  it("company model follows the Console groups with settings pinned in the footer", () => {
    const model = companySidepaneModel({ uid: "co_a", label: "Indigo", liveCount: 3 });
    expect(model.title).toBe("Indigo");
    expect(model.liveCount).toBe(3);
    expect(model.sections.map((s) => s.label ?? null)).toEqual([
      null,
      "People",
      "Brain",
      "Files and connect",
    ]);
    expect(model.sections[0].rows.map((r) => r.id)).toEqual(["atlas", "projects", "activity", "goals"]);
    expect(model.footerRow).toEqual(COMPANY_SETTINGS_ROW);
    const ids = model.sections.flatMap((s) => s.rows.map((r) => r.id));
    expect(ids).not.toContain(COMPANY_SETTINGS_ROW.id);
  });

  it("atlas model selects Atlas and adds Live now and Idle rosters", () => {
    const model = atlasSidepaneModel({ uid: "co_a", label: "Indigo" }, [
      { uid: "u1", name: "Stefan", kind: "human", live: true },
      { uid: "b1", name: "Scout", kind: "bot", live: false },
    ]);
    expect(model.selectedId).toBe("atlas");
    expect(model.liveCount).toBe(1);
    const live = model.sections.find((s) => s.id === "live-now");
    const idle = model.sections.find((s) => s.id === "idle");
    expect(live?.rows).toEqual([{ id: "person:u1", label: "Stefan", mark: "circle", live: true }]);
    expect(idle?.rows).toEqual([{ id: "person:b1", label: "Scout", mark: "square", live: false }]);
  });

  it("adds an Invite a teammate row while the company has one human or fewer (US-014)", () => {
    const empty = atlasSidepaneModel({ uid: "co_n", label: "Northwind" }, []);
    const invite = empty.sections.find((s) => s.id === "invite");
    expect(invite?.label).toBeUndefined();
    expect(invite?.rows).toEqual([{ id: "invite-teammate", label: "Invite a teammate" }]);
    const solo = atlasSidepaneModel({ uid: "co_n", label: "Northwind" }, [
      { uid: "u1", name: "Me", kind: "human", live: false },
    ]);
    expect(solo.sections.some((s) => s.id === "invite")).toBe(true);
    const team = atlasSidepaneModel({ uid: "co_a", label: "Indigo" }, [
      { uid: "u1", name: "Stefan", kind: "human", live: true },
      { uid: "u2", name: "Yousuf", kind: "human", live: false },
    ]);
    expect(team.sections.some((s) => s.id === "invite")).toBe(false);
  });

  it("does not share section rows between model instances", () => {
    const a = companySidepaneModel({ uid: "a", label: "A" });
    a.sections[0].rows[0].count = 9;
    expect(companySidepaneModel({ uid: "b", label: "B" }).sections[0].rows[0].count).toBeUndefined();
  });

  it("renders everything at or below the threshold", () => {
    expect(windowRange(SIDEPANE_VIRTUALIZE_THRESHOLD, 5000, 600)).toEqual({
      start: 0,
      end: SIDEPANE_VIRTUALIZE_THRESHOLD,
      padTop: 0,
      padBottom: 0,
    });
  });

  it("windows long lists to the viewport plus overscan", () => {
    const r = windowRange(1000, 300 * SIDEPANE_ROW_HEIGHT, 600, SIDEPANE_ROW_HEIGHT, 10);
    expect(r.start).toBe(290);
    expect(r.end).toBe(300 + 21 + 10);
    expect(r.padTop).toBe(290 * SIDEPANE_ROW_HEIGHT);
    expect(r.padTop + (r.end - r.start) * SIDEPANE_ROW_HEIGHT + r.padBottom).toBe(1000 * SIDEPANE_ROW_HEIGHT);
    const end = windowRange(1000, 1e9, 600);
    expect(end.end).toBe(1000);
    expect(end.padBottom).toBe(0);
  });

  it("scroll memory keeps one offset per key", () => {
    const m = new SidepaneScrollMemory();
    m.save("home", 120);
    m.save("company:a", 40);
    m.save("home", Number.NaN);
    expect(m.get("home")).toBe(120);
    expect(m.get("company:a")).toBe(40);
    expect(m.get("atlas:a")).toBe(0);
  });
});

describe("Sidepane host (console-rail US-006)", () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("swaps models without remounting the host and preserves Home scroll", async () => {
    target = document.createElement("div");
    document.body.append(target);
    const memory = new SidepaneScrollMemory();
    const props = $state({ modelKey: "home", memory });
    app = mount(SidepaneProbe, { target, props });
    flushSync();
    const host = target.querySelector('[data-testid="sidepane"]');

    const homeScroll = target.querySelector<HTMLElement>(".chat-scroll")!;
    homeScroll.scrollTop = 420;
    homeScroll.dispatchEvent(new Event("scroll"));

    props.modelKey = "company:co_a";
    flushSync();
    await tick();
    expect(target.querySelector('[data-testid="sidepane"]')).toBe(host);
    expect(host?.getAttribute("data-sidepane-model")).toBe("company:co_a");
    const companyScroll = target.querySelector<HTMLElement>(".chat-scroll")!;
    expect(companyScroll).not.toBe(homeScroll);
    expect(companyScroll.scrollTop).toBe(0);
    companyScroll.scrollTop = 60;
    companyScroll.dispatchEvent(new Event("scroll"));

    props.modelKey = "home";
    flushSync();
    await tick();
    await nextFrame();
    expect(target.querySelector('[data-testid="sidepane"]')).toBe(host);
    expect(target.querySelector<HTMLElement>(".chat-scroll")!.scrollTop).toBe(420);
    expect(memory.get("company:co_a")).toBe(60);
  });

  it("is layout-transparent around a self-scrolling Home list", () => {
    target = document.createElement("div");
    document.body.append(target);
    app = mount(SidepaneProbe, { target, props: { modelKey: "home" } });
    flushSync();
    const host = target.querySelector('[data-testid="sidepane"]')!;
    expect(host.classList.contains("transparent")).toBe(true);
    expect(host.getAttribute("role")).toBeNull();
  });
});

describe("SidepaneList (console-rail US-006)", () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target?.remove();
  });

  it("renders section labels and marks the selected row with aria-current", () => {
    target = document.createElement("div");
    document.body.append(target);
    const model = companySidepaneModel({ uid: "co_a", label: "Indigo" }, "projects");
    app = mount(SidepaneList, { target, props: { sections: model.sections, selectedId: model.selectedId } });
    flushSync();
    const labels = [...target.querySelectorAll('[data-testid="sidepane-section-label"]')].map((n) => n.textContent);
    expect(labels).toEqual(["People", "Brain", "Files and connect"]);
    const selected = target.querySelectorAll('[aria-current="page"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].getAttribute("data-row-id")).toBe("projects");
  });

  it("windows lists longer than the threshold", () => {
    target = document.createElement("div");
    document.body.append(target);
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `r${i}`, label: `Row ${i}` }));
    const sections = [{ id: "all", rows }];
    expect(flattenSections(sections)).toHaveLength(1000);
    app = mount(SidepaneList, { target, props: { sections } });
    flushSync();
    const list = target.querySelector('[data-testid="sidepane-list"]')!;
    expect(list.getAttribute("data-windowed")).toBe("true");
    const rendered = target.querySelectorAll('[data-testid="sidepane-row"]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
  });
});
