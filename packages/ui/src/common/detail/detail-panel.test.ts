// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import DetailFacts from "./DetailFacts.svelte";
import DetailActions from "./DetailActions.svelte";
import { isEmptyFactValue, visibleFacts } from "./detail-facts.js";

const mounted: Record<string, unknown>[] = [];
afterEach(() => {
  mounted.splice(0).forEach((m) => unmount(m));
  document.body.innerHTML = "";
});

describe("detail facts", () => {
  it("treats blanks and dash placeholders as empty", () => {
    for (const value of [null, undefined, "", " ", "—", "–", "-"]) expect(isEmptyFactValue(value)).toBe(true);
    expect(isEmptyFactValue("v1")).toBe(false);
    expect(isEmptyFactValue(0)).toBe(false);
  });

  it("renders an empty value as nothing, not an em dash", () => {
    mounted.push(mount(DetailFacts, {
      target: document.body,
      props: { testid: "facts", facts: [
        { label: "Version", value: "v1", mono: true },
        { label: "Created", value: "—" },
        { label: "Used by", value: "" },
      ] },
    }));
    const list = document.querySelector("[data-testid='facts']")!;
    expect([...list.querySelectorAll("dt")].map((n) => n.textContent)).toEqual(["Version"]);
    expect(list.textContent).not.toContain("—");
    expect(visibleFacts([{ label: "A", value: "—" }])).toEqual([]);
  });
});

describe("detail actions", () => {
  it("renders one primary and the secondaries on one row", () => {
    const rotate = vi.fn();
    const bind = vi.fn();
    mounted.push(mount(DetailActions, {
      target: document.body,
      props: {
        testid: "acts",
        primary: { label: "Rotate", icon: "refresh", testid: "rotate", onselect: rotate },
        secondary: [{ label: "Bind to app", icon: "link", testid: "bind", onselect: bind }],
      },
    }));
    flushSync();
    const row = document.querySelector("[data-testid='acts']")!;
    expect(row.querySelectorAll("[data-rail-btn].primary")).toHaveLength(1);
    (row.querySelector("[data-testid='bind']") as HTMLButtonElement).click();
    expect(bind).toHaveBeenCalledOnce();
    expect(row.querySelector("[data-testid='detail-actions-more']")).toBeNull();
  });
});
