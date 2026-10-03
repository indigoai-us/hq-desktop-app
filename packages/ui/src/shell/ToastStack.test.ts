// @vitest-environment happy-dom

/**
 * OWNER-003 shared toast layer: one portal above every overlay, keyed dedupe,
 * three visible plus "+N more", quiet auto-dismiss with hover pause, sticky
 * toasts that stay, Escape untouched, reduced motion, and plain copy only
 * (OWNER-004: no raw updater state keys).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import ToastStack from "./ToastStack.svelte";
import {
  QUIET_TOAST_MS,
  clearToasts,
  pushToast,
  toastItems,
} from "./toast-stack.svelte.js";
import { looksLikeStateKey, updateToastCopy } from "./update-toast.js";
import { syncToastCopy } from "./sync-toast.js";
import { emptySyncStatus, type SyncStatusState } from "../home/sync-status.js";

const SRC = join(__dirname, "..");

let host: HTMLDivElement;
let layers: ReturnType<typeof mount>[] = [];

function mountLayer(): void {
  layers.push(mount(ToastStack, { target: host }));
  flushSync();
}

function shown(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".ts-toast")];
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  for (const layer of layers) unmount(layer);
  layers = [];
  clearToasts();
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("shared toast layer", () => {
  it("portals to <body> above sheets, popovers and dialogs", () => {
    mountLayer();
    pushToast({ title: "Copied", detail: "", tone: "ok" });
    flushSync();
    const stack = document.querySelector('[data-testid="toast-stack"]')!;
    expect(stack.parentElement).toBe(document.body);
    expect(host.contains(stack)).toBe(false);

    const own = readFileSync(join(SRC, "shell/ToastStack.svelte"), "utf8");
    const layerZ = Number(/\.ts-stack\s*\{[^}]*z-index:\s*(\d+)/.exec(own)?.[1]);
    expect(own).toMatch(/\.ts-stack\s*\{[^}]*position:\s*fixed/);
    expect(own.slice(own.indexOf("<style>"))).not.toMatch(/backdrop-filter/);
    let highest = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".svelte") && name !== "ToastStack.svelte") {
          for (const m of readFileSync(path, "utf8").matchAll(/z-index:\s*(\d+)/g)) {
            highest = Math.max(highest, Number(m[1]));
          }
        }
      }
    };
    walk(SRC);
    expect(layerZ).toBeGreaterThan(highest);
  });

  it("paints once when two layers are mounted", () => {
    mountLayer();
    mountLayer();
    pushToast({ title: "Copied", detail: "", tone: "ok" });
    flushSync();
    expect(document.querySelectorAll('[data-testid="toast-stack"]')).toHaveLength(1);
    expect(shown()).toHaveLength(1);
  });

  it("dedupes by key: a repeated notice replaces the shown one", () => {
    mountLayer();
    pushToast({ key: "plan-limit:acme", kind: "sticky", title: "Paused", detail: "one", tone: "neutral" });
    pushToast({ key: "plan-limit:acme", kind: "sticky", title: "Paused", detail: "two", tone: "neutral" });
    flushSync();
    expect(shown()).toHaveLength(1);
    expect(shown()[0].textContent).toContain("two");
  });

  it("shows at most three, newest on top, and counts the rest", () => {
    mountLayer();
    for (const n of [1, 2, 3, 4, 5]) {
      pushToast({ kind: "sticky", title: `Toast ${n}`, detail: "", tone: "neutral" });
    }
    flushSync();
    expect(shown().map((el) => el.querySelector(".ts-title")?.textContent)).toEqual([
      "Toast 5",
      "Toast 4",
      "Toast 3",
    ]);
    expect(document.querySelector('[data-testid="toast-overflow"]')?.textContent).toBe("+2 more");
  });

  it("quiet toasts dismiss themselves and pause while hovered", () => {
    vi.useFakeTimers();
    mountLayer();
    pushToast({ title: "Copied", detail: "", tone: "ok" });
    flushSync();
    const toast = shown()[0];
    expect(toast.dataset.kind).toBe("quiet");

    vi.advanceTimersByTime(QUIET_TOAST_MS - 1000);
    toast.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(QUIET_TOAST_MS * 3);
    flushSync();
    expect(shown()).toHaveLength(1);

    toast.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(999);
    flushSync();
    expect(shown()).toHaveLength(1);
    vi.advanceTimersByTime(2);
    flushSync();
    expect(shown()).toHaveLength(0);
  });

  it("sticky toasts stay until dismissed", () => {
    vi.useFakeTimers();
    mountLayer();
    const onDismiss = vi.fn();
    pushToast({ kind: "sticky", title: "Update available", detail: "", tone: "neutral", onDismiss });
    vi.advanceTimersByTime(QUIET_TOAST_MS * 20);
    flushSync();
    expect(shown()).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-testid="toast-dismiss"]')!.click();
    flushSync();
    expect(shown()).toHaveLength(0);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("Escape never touches toasts", () => {
    mountLayer();
    pushToast({ kind: "sticky", title: "Update available", detail: "", tone: "neutral" });
    flushSync();
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    shown()[0].dispatchEvent(event);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    flushSync();
    expect(shown()).toHaveLength(1);
    expect(event.defaultPrevented).toBe(false);
    expect(toastItems()).toHaveLength(1);
  });

  it("drops the enter motion under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("reduce"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }));
    mountLayer();
    pushToast({ title: "Copied", detail: "", tone: "ok" });
    flushSync();
    const stack = document.querySelector<HTMLElement>('[data-testid="toast-stack"]')!;
    expect(stack.dataset.reducedMotion).toBe("true");
    expect(stack.classList.contains("reduced")).toBe(true);
    const own = readFileSync(join(SRC, "shell/ToastStack.svelte"), "utf8");
    expect(own).toMatch(/\.reduced \.ts-toast\s*\{\s*animation:\s*none/);
    expect(own).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ts-toast\s*\{\s*animation:\s*none/);
  });
});

describe("update toast copy guard (OWNER-004)", () => {
  const states = [
    { version: "0.10.381", reasons: [], installing: false, installError: null },
    { version: "0.10.381", reasons: ["coreUpdateInProgress"], installing: false, installError: null },
    { version: "0.10.381", reasons: ["CoreUpdateInProgress"], installing: false, installError: null },
    { version: "0.10.381", reasons: ["someNewHoldCode"], installing: false, installError: null },
    { version: "0.10.381", reasons: ["uploadInFlight"], installing: false, installError: null },
    { version: "0.10.381", reasons: [], installing: true, installError: null },
    { version: "0.10.381", reasons: [], installing: false, installError: "coreUpdateInProgress" },
    { version: "0.10.381", reasons: [], installing: false, installError: "install_failed" },
    { version: "0.10.381", reasons: [], installing: false, installError: "Could not reach the update server." },
    { version: "0.10.381", reasons: [], installing: false, installError: null, phase: "checking" as const },
    { version: "0.10.381", reasons: [], installing: false, installError: null, phase: "downloading" as const, downloadPercent: 42 },
    { version: "0.10.381", reasons: [], installing: false, installError: null, phase: "downloading" as const },
  ];

  it("never renders a camelCase or snake_case state key", () => {
    for (const state of states) {
      const copy = updateToastCopy(state);
      const text = [copy.title, copy.detail, copy.error ?? "", copy.installLabel].join(" ");
      for (const word of text.split(/\s+/)) {
        expect(looksLikeStateKey(word.replace(/[.,()%…]+$/g, "")), `${word} in "${text}"`).toBe(false);
      }
    }
  });

  it("maps each updater state to plain copy", () => {
    expect(updateToastCopy(states[0]).detail).toBe("HQ 0.10.381 is ready to install");
    expect(updateToastCopy(states[1]).detail).toBe("Waiting for the HQ folder update to finish");
    expect(updateToastCopy(states[3]).detail).toBe("Waiting for HQ to finish a task");
    expect(updateToastCopy(states[6]).error).toBe("Waiting for the HQ folder update to finish");
    expect(updateToastCopy(states[7])).toMatchObject({ title: "Update failed", installLabel: "Try again", installDisabled: false });
    expect(updateToastCopy(states[8]).error).toBe("Could not reach the update server.");
    expect(updateToastCopy(states[9]).title).toBe("Checking for updates");
    expect(updateToastCopy(states[10])).toMatchObject({
      detail: "Downloading HQ 0.10.381 (42%)",
      progress: 0.42,
      installDisabled: true,
      installTitle: "Finishing download",
    });
    expect(updateToastCopy(states[11]).progress).toBe("indeterminate");
    expect(updateToastCopy(states[5]).progress).toBe("indeterminate");
    expect(updateToastCopy(states[0])).toMatchObject({ progress: null, installDisabled: false, installLabel: "Restart to update" });
    expect(updateToastCopy({ ...states[0], reasons: ["uploadInFlight"] }).detail).toBe("Waiting for an upload to finish");
  });

  it("the rendered toast carries no state key", () => {
    mountLayer();
    const copy = updateToastCopy(states[1]);
    pushToast({ kind: "sticky", title: copy.title, detail: copy.detail, error: copy.error, tone: "neutral" });
    flushSync();
    const text = shown()[0].textContent ?? "";
    expect(text).not.toMatch(/\b[a-z]+[A-Z][A-Za-z]*\b/);
    expect(text).toContain("Waiting for the HQ folder update to finish");
  });
});

describe("progress bar", () => {
  it("is determinate when the backend reports counts and indeterminate when only busy", () => {
    mountLayer();
    pushToast({ key: "a", kind: "sticky", title: "Downloading update", detail: "", tone: "neutral", progress: 0.4 });
    pushToast({ key: "b", kind: "sticky", title: "Syncing files", detail: "", tone: "neutral", progress: "indeterminate" });
    pushToast({ key: "c", kind: "sticky", title: "Update available", detail: "", tone: "neutral" });
    flushSync();
    const bars = [...document.querySelectorAll<HTMLElement>('[data-testid="toast-progress"]')];
    expect(bars).toHaveLength(2);
    const [indeterminate, determinate] = bars; // newest first
    expect(indeterminate.classList.contains("indeterminate")).toBe(true);
    expect(indeterminate.getAttribute("aria-valuenow")).toBeNull();
    expect(determinate.getAttribute("aria-valuenow")).toBe("40");
    expect(determinate.querySelector("span")?.style.transform).toBe("scaleX(0.4)");
  });

  it("stops the shimmer under reduced motion", () => {
    const own = readFileSync(join(SRC, "shell/ToastStack.svelte"), "utf8");
    expect(own).toMatch(/\.reduced \.ts-bar\.indeterminate span\s*\{[^}]*animation:\s*none/);
    expect(own).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.ts-bar\.indeterminate span\s*\{[^}]*animation:\s*none/);
  });
});

describe("sync toast copy guard", () => {
  const syncing = (planTotal: number, progressed: number, company: string | null = "Acme"): SyncStatusState => ({
    ...emptySyncStatus(),
    phase: "syncing",
    planTotal,
    progressed,
    company,
  });
  const cases: Array<[SyncStatusState, boolean, boolean]> = [
    [syncing(28, 3), true, false],
    [syncing(0, 2), true, false],
    [syncing(0, 0, null), false, false],
    [emptySyncStatus(), true, false],
    [emptySyncStatus(), false, true],
    [{ ...emptySyncStatus(), phase: "auth-error" }, false, false],
    [{ ...emptySyncStatus(), phase: "conflict" }, false, false],
    [{ ...emptySyncStatus(), phase: "error" }, false, false],
  ];

  it("never renders a sync state key", () => {
    for (const [status, moved, paused] of cases) {
      const copy = syncToastCopy(status, moved, paused);
      for (const word of `${copy.title} ${copy.detail}`.split(/\s+/).filter(Boolean)) {
        expect(looksLikeStateKey(word), word).toBe(false);
      }
    }
  });

  it("maps sync states to plain copy with counted progress", () => {
    expect(syncToastCopy(syncing(28, 3), true, false, () => "Acme")).toEqual({
      state: "busy",
      title: "Syncing 28 files for Acme",
      detail: "3 of 28 done",
      progress: 3 / 28,
    });
    expect(syncToastCopy(syncing(0, 2), true)).toMatchObject({ detail: "2 files done", progress: "indeterminate" });
    // AUDIT-3: the toast names a company only by display name, never the slug.
    expect(syncToastCopy({ ...syncing(28, 3), company: "acme-co" }, true).title).toBe("Syncing 28 files");
    expect(syncToastCopy({ ...syncing(28, 3), company: "acme-co" }, true, false, (slug) => (slug === "acme-co" ? "Acme Co" : null)).title).toBe("Syncing 28 files for Acme Co");
    expect(syncToastCopy(emptySyncStatus(), true)).toMatchObject({ state: "done", title: "Files up to date" });
    expect(syncToastCopy(emptySyncStatus(), false).state).toBe("none");
    expect(syncToastCopy(emptySyncStatus(), false, true).title).toBe("Sync is paused");
  });
});

describe("toast typography outside the chat shell (QA-095)", () => {
  it("never depends on --font-ui without a sans fallback, since the layer is portaled to <body>", () => {
    const own = readFileSync(join(SRC, "shell/ToastStack.svelte"), "utf8");
    const style = own.slice(own.indexOf("<style>"));
    expect(style).not.toMatch(/var\(--font-ui\)/);
    expect(style).toMatch(/\.ts-stack\s*\{[^}]*--ts-font:\s*var\(--font-ui,[^;]*sans-serif\)/);
    for (const rule of style.matchAll(/(?<![-\w])font:\s*[^;]+;/g)) {
      expect(rule[0]).toContain("var(--ts-font)");
    }
  });
});
