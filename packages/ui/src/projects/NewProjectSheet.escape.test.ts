// @vitest-environment happy-dom

// QA-088: Escape in the Linked goal picker closes only the picker; the project
// form stays open with its draft, and a closed draft is restored on reopen.
// QA-089: the picker lists every objective and its key results.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import NewProjectSheet from "./NewProjectSheet.svelte";
import { resetFormDrafts } from "../common/form-drafts.js";
import { overlayDepth } from "../common/dismissable.js";
import type { Objective } from "./local-projects.js";

let component: ReturnType<typeof mount> | null = null;

const objectives: Objective[] = [
  {
    id: "grow-sales",
    title: "Grow Sales",
    description: "",
    keyResults: [
      { id: "site-cvr", title: "Site CVR" },
      { id: "aov", title: "Average order value" },
    ],
    initiativeIds: [],
  } as unknown as Objective,
];

function open(onclose = vi.fn()) {
  component = mount(NewProjectSheet, {
    target: document.body,
    props: { company: "hpo", companies: ["hpo"], objectives, onclose, oncreate: vi.fn() },
  });
  flushSync();
  return onclose;
}

async function close(): Promise<void> {
  if (component) await unmount(component);
  component = null;
  document.body.innerHTML = "";
}

function escape(from: Element | null = document.activeElement): void {
  (from ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  flushSync();
}

function typeName(value: string): void {
  const input = document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!;
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

function openPicker(): void {
  document.querySelector<HTMLButtonElement>('[data-testid="link-picker-field"]')!.click();
  flushSync();
}

beforeEach(() => resetFormDrafts());
afterEach(close);

describe("New project nested Escape (QA-088)", () => {
  it("closes only the goal picker and keeps the form and its name", () => {
    const onclose = open();
    typeName("qa-cancelled-project-draft");
    openPicker();
    expect(document.querySelector('[data-testid="link-picker-list"]')).not.toBeNull();
    expect(overlayDepth()).toBe(2);

    escape(document.querySelector('[data-testid="link-picker-search"]'));

    expect(document.querySelector('[data-testid="link-picker-list"]')).toBeNull();
    expect(document.querySelector('[data-testid="new-project-sheet"]')).not.toBeNull();
    expect(document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!.value).toBe(
      "qa-cancelled-project-draft",
    );
    expect(onclose).not.toHaveBeenCalled();
  });

  it("does not fire page-level window Escape handlers while the picker is open", () => {
    const pageEscape = vi.fn();
    window.addEventListener("keydown", pageEscape);
    try {
      open();
      openPicker();
      escape(document.querySelector('[data-testid="link-picker-search"]'));
      expect(pageEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", pageEscape);
    }
  });

  it("asks Discard draft? on a second Escape only when fields are filled", () => {
    const onclose = open();
    typeName("draft");
    escape();
    expect(document.querySelector('[data-testid="new-project-discard"]')).not.toBeNull();
    expect(onclose).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-testid="new-project-discard-confirm"]')!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("closes straight away on Escape when the form is empty", () => {
    const onclose = open();
    escape();
    expect(document.querySelector('[data-testid="new-project-discard"]')).toBeNull();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("restores a closed draft on reopen with a Clear affordance", async () => {
    open();
    typeName("keep-me");
    document.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    await close();

    open();
    expect(document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!.value).toBe("keep-me");
    const banner = document.querySelector('[data-testid="new-project-draft-restored"]');
    expect(banner?.textContent).toContain("Draft restored");
    banner!.querySelector("button")!.click();
    flushSync();
    expect(document.querySelector<HTMLInputElement>('[data-testid="new-project-name"]')!.value).toBe("");
  });
});

describe("New project Linked goal picker (QA-089)", () => {
  it("lists the objective and both key results", () => {
    open();
    openPicker();
    const rows = Array.from(document.querySelectorAll('[data-testid="link-picker-option"]')).map((row) =>
      row.textContent?.trim(),
    );
    expect(rows).toHaveLength(3);
    expect(rows.join(" | ")).toContain("Site CVR");
    expect(rows.join(" | ")).toContain("Average order value");
  });
});
