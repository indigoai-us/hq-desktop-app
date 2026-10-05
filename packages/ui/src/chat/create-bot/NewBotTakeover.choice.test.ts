// @vitest-environment happy-dom

/**
 * Owner (2026-10-05): "new bot process should ask if you want cloud or local
 * first". The takeover opens on a "Cloud or Local?" question for every New
 * bot entry; a starting bot's row still goes straight to its waking screen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import NewBotTakeover from "./NewBotTakeover.svelte";
import { beginWakingSession } from "./waking-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

const PROVISION = {
  ok: true as const,
  value: {
    defaultInstanceType: "t4g.medium",
    catalogVersion: "test",
    options: [
      {
        key: "basic" as const,
        productName: "Basic",
        instanceType: "t4g.medium",
        listCents: 5000,
        default: true,
        selectable: true,
        netMonthlyCents: 5000,
        deltaCents: 5000,
        unavailableReason: null,
        notBilled: false,
        lanes: 1,
        workers: 1,
      },
    ],
  },
};

/** Props for a takeover that has its own cloud create screen. */
const CLOUD_SCREEN = {
  companies: [{ companyUid: "cmp_acme", label: "Acme" }],
  currentCompanyUid: "cmp_acme",
  runtimeReady: { codex: true },
  loadProvisionOptions: async () => PROVISION,
  oncreate: vi.fn(async () => ({ ok: false as const, blocked: false, reason: "" })),
};

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NewBotTakeover, {
    target: host,
    props: { oncancel: vi.fn(), ...props },
  });
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotTakeover: Cloud or Local first", () => {
  it("opens on the choice, inside the takeover card, before any create screen", async () => {
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal: vi.fn() });
    await settle();

    const card = q('[data-testid="new-bot-takeover"] .new-bot-takeover-card');
    expect(card?.querySelector('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    expect(q("#new-bot-takeover-title")?.textContent).toContain("Where should it run?");
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(cloud.textContent).toContain("Cloud");
    expect(cloud.textContent).toContain("Always on");
    expect(local.textContent).toContain("Local");
    expect(local.textContent).toContain("with your coding tool");
  });

  it("Cloud opens the takeover's own create screen, and Back returns to the choice", async () => {
    render({ choose: true, ...CLOUD_SCREEN });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.click();
    await settle();

    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    q<HTMLButtonElement>('[data-testid="new-bot-back-to-choice"]')!.click();
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
  });

  it("Cloud with no company of its own hands off to the host's cloud flow", async () => {
    const onchoosecloud = vi.fn();
    render({ choose: true, onchoosecloud });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.click();
    await settle();
    expect(onchoosecloud).toHaveBeenCalledOnce();
  });

  it("Local hands off to the host's local flow", async () => {
    const onchooselocal = vi.fn();
    const onchoosecloud = vi.fn();
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal, onchoosecloud });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.click();
    await settle();
    expect(onchooselocal).toHaveBeenCalledOnce();
    expect(onchoosecloud).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
  });

  it("shows an option it cannot offer as disabled, with a one-line reason in place of its description", async () => {
    const onchooselocal = vi.fn();
    render({
      choose: true,
      cloudReason: "Cloud bots run in a company. Join or create one first.",
      onchooselocal,
    });
    await settle();
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Cloud bots run in a company. Join or create one first.");
    expect(cloud.textContent).not.toContain("Always on");
    // No warning glyphs: the reason is plain text.
    expect(cloud.textContent).not.toMatch(/[⚠!]/u);
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.disabled).toBe(false);
  });

  it("focuses the first option it can offer, moves with the arrow keys, and picks with a click or Enter", async () => {
    const onchooselocal = vi.fn();
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal });
    await settle();
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(document.activeElement).toBe(cloud);
    cloud.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(local);
    local.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cloud);
    // Buttons: Enter activates them natively, as a click.
    expect(cloud.tagName).toBe("BUTTON");
    expect(local.getAttribute("type")).toBe("button");
  });

  it("skips a disabled option with the arrow keys", async () => {
    render({ choose: true, cloudReason: "No cloud here.", onchooselocal: vi.fn() });
    await settle();
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(document.activeElement).toBe(local);
    local.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(local);
  });

  it("Escape and Cancel on the choice leave the takeover as before", async () => {
    const oncancel = vi.fn();
    render({ choose: true, oncancel, onchooselocal: vi.fn() });
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(oncancel).toHaveBeenCalledOnce();
    q<HTMLButtonElement>('[data-testid="new-bot-takeover-cancel"]')!.click();
    expect(oncancel).toHaveBeenCalledTimes(2);
  });

  it("a starting bot's row goes straight to its waking screen, with no question", async () => {
    const session = beginWakingSession({
      agentUid: "agt_nova",
      channelId: "chn_nova",
      companyUid: "cmp_acme",
      name: "Nova",
      brain: "codex",
    });
    render({ choose: false, ...CLOUD_SCREEN, wakingSession: session });
    await settle();
    expect(q('[data-testid="new-bot-waking-screen"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
  });

  it("without the choice (the waking path's way in), the create screen has no Back to a question", async () => {
    render({ ...CLOUD_SCREEN });
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-back-to-choice"]')).toBeNull();
  });

  it("marks hover and focus with a background only: no left accent bar or edge stripe", () => {
    const css = readFileSync(resolve(process.cwd(), "src/chat/create-bot/new-bot-takeover.css"), "utf8");
    const rules = [...css.matchAll(/([^{}]*\.new-bot-choice[^{}]*)\{([^}]*)\}/gu)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, selector, body] of rules) {
      expect(body, selector).not.toMatch(/border-left|border-inline-start|inset\s+\d+px\s+0/u);
      expect(selector, selector).not.toMatch(/::before|::after/u);
    }
    expect(css).toMatch(/\.new-bot-choice-option:hover:not\(:disabled\),\s*\.new-bot-choice-option:focus-visible\s*\{\s*background:/u);
  });
});
