// @vitest-environment happy-dom
/**
 * Step 3 of the badge cards (owner decision 2026-10-08): a quiet "You earned
 * <Badge>" notice with "Reveal card", which opens the card with its staged
 * entrance. Every tier gets the reveal (owner review 2026-10-08). A demo
 * for now: nothing in the app raises it (no earning events yet).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceBadgeEarned, revealBadgeCard } from "./badge-announce.js";
import { BADGE_BY_ID } from "./badge-catalog.js";
import { REVEAL_FLIP_MS, REVEAL_GLOW_MS } from "./badge-card.js";
import { QUIET_TOAST_MS, clearToasts, toastItems } from "../shell/toast-stack.svelte.js";

beforeEach(() => {
  Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
  const shell = document.createElement("div");
  shell.className = "desktop-shell";
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  document.body.appendChild(shell);
});

afterEach(() => {
  clearToasts();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("You earned", () => {
  it("offers the card reveal for Gold and Legendary, and keeps that notice until it is used", () => {
    announceBadgeEarned({ id: "poweruser", tier: 3, earnedAt: "2026-10-08" });
    announceBadgeEarned({ id: "founding", earnedAt: "2026-10-08" });
    const [gold, legendary] = toastItems();
    expect(gold).toMatchObject({ title: "You earned Power User", detail: "Gold · Skills run.", kind: "sticky", tone: "neutral" });
    expect(gold.actions?.map((a) => a.label)).toEqual(["Reveal card"]);
    expect(legendary.title).toBe("You earned Founding Member");
    expect(legendary.actions?.[0]).toMatchObject({ label: "Reveal card", primary: true, testId: "badge-earned-reveal" });
  });

  it("offers the reveal for Bronze and Silver too, and keeps those notices until they are used", () => {
    vi.useFakeTimers();
    announceBadgeEarned({ id: "liftoff", tier: 1, earnedAt: "2026-10-08" });
    announceBadgeEarned({ id: "bughunter", tier: 2, earnedAt: "2026-10-08" });
    expect(toastItems().map((t) => [t.title, t.detail, t.kind, t.actions?.map((a) => a.label)])).toEqual([
      ["You earned Liftoff", "Bronze · Deploys that went live.", "sticky", ["Reveal card"]],
      ["You earned Bug Hunter", "Silver · " + BADGE_BY_ID.bughunter.crit + ".", "sticky", ["Reveal card"]],
    ]);
    vi.advanceTimersByTime(QUIET_TOAST_MS);
    expect(toastItems()).toHaveLength(2);
  });

  it("reveals a Bronze card with its staged entrance", () => {
    announceBadgeEarned({ id: "liftoff", tier: 1, earnedAt: "2026-10-08" });
    toastItems()[0].actions![0].onAction();
    flushSync();
    const modal = document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement | null;
    expect(modal?.dataset.reveal).toBe("true");
    expect(modal?.querySelector(".bc-stage.t1 .bc-glow")).not.toBeNull();
  });

  it("ignores a badge the catalog does not know, and never stacks the same badge twice", () => {
    expect(announceBadgeEarned({ id: "nope", earnedAt: "2026-10-08" })).toBeNull();
    announceBadgeEarned({ id: "founding", earnedAt: "2026-10-08" });
    announceBadgeEarned({ id: "founding", earnedAt: "2026-10-08" });
    expect(toastItems()).toHaveLength(1);
  });

  it("Reveal card opens the card with its staged entrance, then the normal card", async () => {
    vi.useFakeTimers();
    announceBadgeEarned({ id: "founding", earnedAt: "2026-10-08" });
    toastItems()[0].actions![0].onAction();
    flushSync();
    const modal = () => document.querySelector('[data-testid="badge-card-modal"]') as HTMLElement | null;
    expect(modal()?.dataset.reveal).toBe("true");
    expect(modal()?.dataset.phase).toBe("glow");
    expect(modal()?.querySelector(".bc-glow")).not.toBeNull();
    vi.advanceTimersByTime(REVEAL_GLOW_MS);
    flushSync();
    expect(modal()?.dataset.phase).toBe("flip");
    vi.advanceTimersByTime(REVEAL_FLIP_MS);
    flushSync();
    expect(modal()?.dataset.phase).toBe("done");
    // Closing takes the card down and puts focus back on the app.
    (modal()!.querySelector('[data-testid="badge-card-close"]') as HTMLButtonElement).click();
    flushSync();
    await tick();
    expect(modal()).toBeNull();
    expect(document.activeElement?.hasAttribute("data-shell-focus-fallback")).toBe(true);
  });

  it("closes from the function it returns", () => {
    const close = revealBadgeCard({ def: BADGE_BY_ID.poweruser, tier: 3, earnedAt: "2026-10-08" });
    flushSync();
    expect(document.querySelector('[data-testid="badge-card-modal"]')).not.toBeNull();
    close();
    flushSync();
    expect(document.querySelector('[data-testid="badge-card-modal"]')).toBeNull();
  });
});

describe("the notice is a demo", () => {
  it("no app code raises it: only the badges module defines it and the package re-exports it", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
          if (/\b(announceBadgeEarned|revealBadgeCard)\s*\(/.test(readFileSync(path, "utf8"))) callers.push(relative(src, path));
        }
      }
    };
    walk(src);
    expect(callers).toEqual(["badges/badge-announce.ts"]);
  });
});
