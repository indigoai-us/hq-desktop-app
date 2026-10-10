// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import RuntimeRepairCard from "./RuntimeRepairCard.svelte";
import { repairCardView, type RepairCardState, type RepairPayload } from "./runtime-repair-model.js";

const here = dirname(fileURLToPath(import.meta.url));
let mounted: Array<ReturnType<typeof mount>> = [];
let hosts: HTMLElement[] = [];

afterEach(async () => {
  for (const component of mounted) await unmount(component);
  mounted = [];
  for (const host of hosts) host.remove();
  hosts = [];
  document.documentElement.removeAttribute("data-force-theme");
  document.documentElement.classList.remove("dark");
});

function payload(cls: RepairPayload["class"], runtime: RepairPayload["runtime"] = "claude"): RepairPayload {
  const action = ({ "signed-out": "signIn", "cli-outdated": "update", "model-unsupported": "switchModel", transient: "tryAgain" } as const)[cls];
  return { v: 1, kind: "runtime-repair", class: cls, runtime, action, botName: "scout" };
}

/** The seven states of the approved mockup. */
const STATES: Array<{ id: string; payload: RepairPayload; state: RepairCardState }> = [
  { id: "signed-out", payload: payload("signed-out"), state: { phase: "offered" } },
  { id: "update", payload: payload("cli-outdated", "codex"), state: { phase: "offered" } },
  { id: "model", payload: payload("model-unsupported"), state: { phase: "offered" } },
  { id: "transient", payload: payload("transient"), state: { phase: "offered" } },
  { id: "signing-in", payload: payload("signed-out"), state: { phase: "working", action: "signIn" } },
  { id: "updating", payload: payload("cli-outdated", "codex"), state: { phase: "working", action: "update" } },
  { id: "fixed", payload: payload("signed-out"), state: { phase: "fixed", action: "signIn" } },
];

const EXPECTED: Record<string, { title: string; line: string; mark: string | null; primary: string | null; secondary: string | null; phase: string; state: string }> = {
  "signed-out": {
    title: "Claude Code is signed out",
    line: "Pickles needs Claude Code to reply. Sign in and Pickles picks up your message.",
    mark: null,
    primary: "Sign in",
    secondary: null,
    phase: "offered",
    state: "offered",
  },
  update: {
    title: "Codex needs an update",
    line: "This version of Codex is too old for Pickles. The update takes about a minute.",
    mark: null,
    primary: "Update",
    secondary: null,
    phase: "offered",
    state: "offered",
  },
  model: {
    title: "Pickles’s model isn’t available",
    line: "Claude Code on this Mac can’t run the model Pickles is set to. Switch to one it supports, or update.",
    mark: null,
    primary: "Use a supported model",
    secondary: "Update Claude Code",
    phase: "offered",
    state: "offered",
  },
  transient: {
    title: "Pickles couldn’t reply",
    line: "Something interrupted Claude Code. Your message is saved.",
    mark: null,
    primary: "Try again",
    secondary: null,
    phase: "offered",
    state: "offered",
  },
  "signing-in": {
    title: "Claude Code",
    line: "Finish in the browser window that just opened.",
    mark: "Signing in…",
    primary: "Signing in…",
    secondary: null,
    phase: "working",
    state: "connecting",
  },
  updating: {
    title: "Codex",
    line: "Updating Codex. Pickles replies as soon as it’s done.",
    mark: "Updating…",
    primary: "Updating…",
    secondary: null,
    phase: "working",
    state: "connecting",
  },
  fixed: {
    title: "You’re all set",
    line: "Send me anything.",
    mark: "Signed in",
    primary: null,
    secondary: null,
    phase: "fixed",
    state: "connected",
  },
};

async function render(view: ReturnType<typeof repairCardView>, onaction?: (a: string) => void | Promise<void>): Promise<HTMLElement> {
  const host = document.createElement("div");
  host.className = "chat-shell";
  document.body.appendChild(host);
  hosts.push(host);
  mounted.push(mount(RuntimeRepairCard, { target: host, props: { view, onaction } }));
  await tick();
  flushSync();
  return host.querySelector<HTMLElement>('[data-testid="runtime-repair-card"]')!;
}

const text = (el: Element | null) => el?.textContent?.replace(/\s+/g, " ").trim() ?? null;

describe("RuntimeRepairCard", () => {
  for (const theme of ["light", "dark"] as const) {
    describe(`in the ${theme} theme`, () => {
      for (const s of STATES) {
        it(`draws the ${s.id} state as approved`, async () => {
          if (theme === "light") document.documentElement.setAttribute("data-force-theme", "light");
          else document.documentElement.classList.add("dark");
          const card = await render(repairCardView(s.payload, s.state, "Pickles"));
          const want = EXPECTED[s.id]!;
          expect(card.classList.contains("connection-card")).toBe(true);
          expect(card.dataset.kind).toBe("runtime-repair");
          expect(card.dataset.phase).toBe(want.phase);
          expect(card.dataset.state).toBe(want.state);
          expect(text(card.querySelector('[data-testid="runtime-repair-title"]'))).toBe(want.title);
          expect(text(card.querySelector('[data-testid="runtime-repair-line"]'))).toBe(want.line);
          expect(text(card.querySelector('[data-testid="runtime-repair-mark"]'))).toBe(want.mark);
          const primary = card.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-primary"]');
          const secondary = card.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-secondary"]');
          expect(text(primary)).toBe(want.primary);
          expect(text(secondary)).toBe(want.secondary);
          if (want.phase === "working") {
            expect(primary!.disabled).toBe(true);
            expect(card.getAttribute("aria-busy")).toBe("true");
            expect(card.querySelector(".connection-card-spin")).not.toBeNull();
          }
          // The art is the app's own bundled wallpaper; the card takes no inline style.
          expect(card.getAttribute("style")).toBeNull();
          expect(card.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage).toMatch(/new-bot-wallpapers|\.jpg/);
          expect(card.textContent).not.toMatch(/[–—]/);
        });
      }
    });
  }

  it("keeps one wallpaper per problem through working and fixed", async () => {
    const offered = await render(repairCardView(payload("signed-out"), { phase: "offered" }, "Pickles"));
    const fixed = await render(repairCardView(payload("signed-out"), { phase: "fixed", action: "signIn" }, "Pickles"));
    const art = (el: HTMLElement) => el.querySelector<HTMLElement>(".connection-card-art")!.style.backgroundImage;
    expect(art(offered)).toBe(art(fixed));
    expect(art(offered)).toContain("aurora");
  });

  it("tells the host which action a button runs, once per press", async () => {
    let finish: () => void = () => {};
    const onaction = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const card = await render(repairCardView(payload("model-unsupported"), { phase: "offered" }, "Pickles"), onaction);
    const primary = card.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-primary"]')!;
    primary.click();
    primary.click();
    expect(onaction).toHaveBeenCalledTimes(1);
    expect(onaction).toHaveBeenCalledWith("switchModel");
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync();
    card.querySelector<HTMLButtonElement>('[data-testid="runtime-repair-secondary"]')!.click();
    expect(onaction).toHaveBeenLastCalledWith("update");
  });

  it("shares ConnectionCard's stylesheet instead of copying it", () => {
    const cardSource = readFileSync(join(here, "RuntimeRepairCard.svelte"), "utf8");
    const connectionSource = readFileSync(join(here, "ConnectionCard.svelte"), "utf8");
    expect(cardSource).toContain('import "./connection-card.css";');
    expect(connectionSource).toContain('import "./connection-card.css";');
    // Neither component carries its own copy of the card's rules.
    expect(cardSource).not.toMatch(/<style/);
    expect(connectionSource).not.toMatch(/<style/);
    // Dark in both app themes: no theme variable in the card's colours.
    const css = readFileSync(join(here, "connection-card.css"), "utf8");
    expect(css).not.toMatch(/var\(--(t1|t2|t3|ground|elevated|line|line2)\)/);
    expect(css).not.toMatch(/backdrop-filter:\s*blur/);
  });
});
