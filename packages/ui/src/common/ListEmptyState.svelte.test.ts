// @vitest-environment happy-dom

// QA-058 contract for the shared list empty state: a search or filter that
// hides every row says "No matches for '<query>'", keeps the list total in
// view, and offers Clear search. "Nothing here yet" is only for a list whose
// unfiltered source is empty.

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ListEmptyState from "./ListEmptyState.svelte";
import { listEmptyState } from "./list-empty-state.js";

const FILES = ["file", "files"] as const;

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
});

function render(props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ListEmptyState, { target: host, props: props as never });
  flushSync();
  return host;
}

describe("listEmptyState", () => {
  it("returns null while rows are visible", () => {
    expect(listEmptyState({ total: 19, shown: 3, query: "a", noun: FILES })).toBeNull();
  });

  it("names the query and keeps the total when a search hides every row", () => {
    expect(listEmptyState({ total: 19, shown: 0, query: " zzz ", noun: FILES })).toEqual({
      kind: "no-matches",
      title: "No matches for 'zzz'",
      totalLabel: "19 files",
    });
  });

  it("treats an active filter with no query as no matches", () => {
    expect(listEmptyState({ total: 1, shown: 0, filtered: true, noun: FILES })).toEqual({
      kind: "no-matches",
      title: "No files match these filters",
      totalLabel: "1 file",
    });
  });

  it("uses the empty copy only when the unfiltered list is empty", () => {
    expect(listEmptyState({ total: 0, shown: 0, query: "zzz", noun: FILES })).toEqual({
      kind: "empty",
      title: "Nothing here yet.",
    });
    expect(
      listEmptyState({ total: 0, shown: 0, noun: FILES, emptyCopy: "No secrets yet" }),
    ).toEqual({ kind: "empty", title: "No secrets yet" });
  });
});

describe("ListEmptyState", () => {
  it("renders no matches, the total, and a working Clear search", () => {
    const onclear = vi.fn();
    const el = render({ total: 19, shown: 0, query: "zzz", noun: FILES, onclear });
    const root = el.querySelector('[data-testid="list-empty-state"]') as HTMLElement;
    expect(root.dataset.kind).toBe("no-matches");
    expect(root.textContent).toContain("No matches for 'zzz'");
    expect(root.textContent).toContain("19 files");
    expect(root.textContent).not.toContain("Nothing here yet");
    const clear = el.querySelector('[data-testid="list-empty-state-clear"]') as HTMLButtonElement;
    expect(clear.textContent?.trim()).toBe("Clear search");
    clear.click();
    expect(onclear).toHaveBeenCalledOnce();
  });

  it("labels the button Clear filters when only a filter is active", () => {
    const el = render({ total: 4, shown: 0, filtered: true, noun: FILES, onclear: () => {} });
    expect(el.querySelector('[data-testid="list-empty-state-clear"]')?.textContent?.trim()).toBe(
      "Clear filters",
    );
  });

  it("renders the empty copy without a total or clear action for an empty list", () => {
    const el = render({ total: 0, shown: 0, query: "", noun: FILES, onclear: () => {} });
    const root = el.querySelector('[data-testid="list-empty-state"]') as HTMLElement;
    expect(root.dataset.kind).toBe("empty");
    expect(root.textContent?.trim()).toBe("Nothing here yet.");
    expect(el.querySelector('[data-testid="list-empty-state-clear"]')).toBeNull();
  });

  it("renders nothing while rows are visible", () => {
    const el = render({ total: 3, shown: 3, query: "", noun: FILES });
    expect(el.querySelector('[data-testid="list-empty-state"]')).toBeNull();
  });
});
