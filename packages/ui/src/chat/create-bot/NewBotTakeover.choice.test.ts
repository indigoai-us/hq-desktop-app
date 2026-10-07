// @vitest-environment happy-dom

/**
 * Owner (2026-10-07): the bot's name is step 1 on every New bot path. The
 * takeover asks the name, then "Where should <Name> live?" with Cloud and
 * Local as two tiles, then hands the name to whichever path was picked. A
 * starting bot's row still goes straight to its waking screen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

/** Name the bot on the first step and continue to the where question. */
async function nameIt(name = "Nova"): Promise<void> {
  const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
  input.value = name;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
  await settle();
}

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(NewBotTakeover, {
    target: host,
    props: { oncancel: vi.fn(), ...props },
  });
}

// The tiles name the machine the app runs on; run as the Mac it ships on.
const globals = globalThis as { __HQ_HOST_OS__?: string };
const priorHostOs = globals.__HQ_HOST_OS__;
beforeAll(() => {
  globals.__HQ_HOST_OS__ = "macos";
});
afterAll(() => {
  if (priorHostOs === undefined) delete globals.__HQ_HOST_OS__;
  else globals.__HQ_HOST_OS__ = priorHostOs;
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("NewBotTakeover: the name first, then where it should live", () => {
  it("opens on the name, inside the takeover card, before any choice or create screen", async () => {
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal: vi.fn() });
    await settle();

    const card = q('[data-testid="new-bot-takeover"] .new-bot-takeover-card');
    expect(card?.querySelector('[data-testid="new-bot-name-screen"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Enter a name.");
    expect(document.activeElement).toBe(q('[data-testid="new-bot-name"]'));
    // Name, where, brain: one company, so no company step.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 3");
  });

  it("asks where the named bot should live, with the name set apart, on two tiles", async () => {
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal: vi.fn() });
    await settle();
    await nameIt("Nova");

    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
    expect(q("#new-bot-takeover-title em")?.textContent).toBe("Nova");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 3");
    // The misleading line about changing it later is gone; the subline says
    // the other kind can be added any time.
    expect(document.body.textContent).not.toContain("change it on the next step");
    expect(q('[data-testid="new-bot-choice-sub"]')?.textContent).toBe(
      "Pick one. You can add the other kind of bot any time.",
    );
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(cloud.querySelector(".new-bot-choice-title")?.textContent).toBe("Cloud");
    expect(cloud.querySelector(".new-bot-choice-body")?.textContent?.trim()).toBe("Always on. Access anywhere.");
    expect([...cloud.querySelectorAll(".new-bot-choice-tag")].map((t) => t.textContent)).toEqual(["Always on", "Slack"]);
    expect(local.querySelector(".new-bot-choice-title")?.textContent).toBe("Local");
    expect(local.querySelector(".new-bot-choice-body")?.textContent?.trim()).toBe("Runs on this machine.");
    // Codex is the tool signed in here, so the Local tile names it.
    expect([...local.querySelectorAll(".new-bot-choice-tag")].map((t) => t.textContent)).toEqual(["This Mac", "Codex"]);
    // Each tile wears its own glass orb, not a rail glyph.
    expect(cloud.querySelector('[data-testid="new-bot-orb-cloud"]')).toBeTruthy();
    expect(local.querySelector('[data-testid="new-bot-orb-local"]')).toBeTruthy();
    expect(cloud.querySelector(".rail-icon")).toBeNull();
    expect(local.querySelector(".rail-icon")).toBeNull();
  });

  it("names no tool on the Local tile when none is known to be signed in", async () => {
    render({ choose: true, ...CLOUD_SCREEN, runtimeReady: null, onchooselocal: vi.fn() });
    await settle();
    await nameIt();
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect([...local.querySelectorAll(".new-bot-choice-tag")].map((t) => t.textContent)).toEqual(["This Mac", "Your tools"]);
  });

  it("holds the name step on an empty name or one no handle can be made from", async () => {
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal: vi.fn() });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-continue-name"]')!.click();
    await settle();
    expect(q('[data-testid="new-bot-name-issue"]')?.textContent).toBe("Give your bot a name.");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    await nameIt("日本語");
    expect(q('[data-testid="new-bot-name-issue"]')?.textContent).toBe(
      "That name can't be used for a bot. Try letters and numbers.",
    );
    await nameIt("日本語 Bot 2");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  });

  it("Enter on the name moves on", async () => {
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal: vi.fn() });
    await settle();
    const input = q<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = "Nova";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
  });

  it("Cloud opens the takeover's own create screen with the name, and Back returns to the choice, then the name", async () => {
    render({ choose: true, ...CLOUD_SCREEN });
    await settle();
    await nameIt("Nova");
    q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.click();
    await settle();

    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    // The cloud screen has no name step of its own: it names the bot above the brain.
    expect(q('[data-testid="new-bot-name"]')).toBeNull();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 3 of 3");
    q<HTMLButtonElement>('[data-testid="new-bot-back-to-choice"]')!.click();
    await settle();
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
    q<HTMLButtonElement>('[data-testid="new-bot-back-to-name"]')!.click();
    await settle();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Nova");
  });

  it("Cloud with no company of its own hands the name to the host's cloud flow", async () => {
    const onchoosecloud = vi.fn();
    render({ choose: true, onchoosecloud });
    await settle();
    await nameIt("Nova");
    q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!.click();
    await settle();
    expect(onchoosecloud).toHaveBeenCalledWith("Nova");
  });

  it("Local hands the name to the host's local flow", async () => {
    const onchooselocal = vi.fn();
    const onchoosecloud = vi.fn();
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal, onchoosecloud });
    await settle();
    await nameIt("Nova");
    q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.click();
    await settle();
    expect(onchooselocal).toHaveBeenCalledWith("Nova");
    expect(onchoosecloud).not.toHaveBeenCalled();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeNull();
  });

  it("opens on the where question with a name given earlier (Back from the local steps)", async () => {
    render({ choose: true, ...CLOUD_SCREEN, initialName: "Nova", onchooselocal: vi.fn() });
    await settle();
    expect(q('[data-testid="new-bot-name"]')).toBeNull();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
  });

  it("opens on the cloud create screen with a name given earlier (Create a cloud bot instead)", async () => {
    render({ choose: true, openCloud: true, ...CLOUD_SCREEN, initialName: "Nova" });
    await settle();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q('[data-testid="bot-identity-name"]')?.textContent).toBe("Nova");
    q<HTMLButtonElement>('[data-testid="new-bot-back-to-choice"]')!.click();
    await settle();
    expect(q("#new-bot-takeover-title")?.textContent).toBe("Where should Nova live?");
  });

  it("shows an option it cannot offer as disabled, with a one-line reason in place of its description", async () => {
    const onchooselocal = vi.fn();
    render({
      choose: true,
      cloudReason: "Cloud bots run in a company. Join or create one first.",
      onchooselocal,
    });
    await settle();
    await nameIt();
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    expect(cloud.disabled).toBe(true);
    expect(cloud.textContent).toContain("Cloud bots run in a company. Join or create one first.");
    expect(cloud.textContent).not.toContain("Always on");
    expect(cloud.textContent).not.toContain("Access anywhere");
    // No warning glyphs: the reason is plain text.
    expect(cloud.textContent).not.toMatch(/[⚠!]/u);
    expect(q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!.disabled).toBe(false);
  });

  it("focuses the first option it can offer, moves with the arrow keys, and picks with a click or Enter", async () => {
    const onchooselocal = vi.fn();
    render({ choose: true, ...CLOUD_SCREEN, onchooselocal });
    await settle();
    await nameIt();
    const cloud = q<HTMLButtonElement>('[data-testid="new-bot-choice-cloud"]')!;
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(document.activeElement).toBe(cloud);
    cloud.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(local);
    local.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(cloud);
    // Buttons: Enter activates them natively, as a click.
    expect(cloud.tagName).toBe("BUTTON");
    expect(local.getAttribute("type")).toBe("button");
  });

  it("skips a disabled option with the arrow keys", async () => {
    render({ choose: true, cloudReason: "No cloud here.", onchooselocal: vi.fn() });
    await settle();
    await nameIt();
    const local = q<HTMLButtonElement>('[data-testid="new-bot-choice-local"]')!;
    expect(document.activeElement).toBe(local);
    local.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(local);
  });

  it("Escape and Cancel on the name and the choice leave the takeover as before", async () => {
    const oncancel = vi.fn();
    render({ choose: true, oncancel, onchooselocal: vi.fn() });
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(oncancel).toHaveBeenCalledOnce();
    await nameIt();
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
    expect(q('[data-testid="new-bot-name"]')).toBeNull();
  });

  it("without the choice (the waking path's way in), the name leads to the create screen and Back returns to the name", async () => {
    render({ ...CLOUD_SCREEN });
    await settle();
    // Name and brain: the where question is not part of this way in.
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 1 of 2");
    await nameIt("Nova");
    expect(q('[data-testid="new-bot-kind-choice"]')).toBeNull();
    expect(q('[data-testid="new-bot-create-screen"]')).toBeTruthy();
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 2");
    q<HTMLButtonElement>('[data-testid="new-bot-back-to-choice"]')!.click();
    await settle();
    expect(q<HTMLInputElement>('[data-testid="new-bot-name"]')?.value).toBe("Nova");
  });

  it("never shows the old fallback screen", () => {
    const src = readFileSync(resolve(process.cwd(), "src/chat/create-bot/NewBotTakeover.svelte"), "utf8");
    expect(src).not.toContain("Name and brain are next.");
    expect(src).not.toContain("Meet your <em>next</em> bot.");
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

  it("lifts a tile on hover only when motion is allowed, and keeps the tags on one line", () => {
    const css = readFileSync(resolve(process.cwd(), "src/chat/create-bot/new-bot-takeover.css"), "utf8");
    const hover = css.match(/\.new-bot-choice-option:hover:not\(:disabled\),\s*\.new-bot-choice-option:focus-visible\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(hover).toMatch(/transform:\s*translateY\(-2px\)/u);
    const reduced = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.new-bot-choice-option,[^{]*\{([^}]*)\}/u)?.[1] ?? "";
    expect(reduced).toMatch(/transform:\s*none/u);
    const tags = css.match(/\.new-bot-choice-tags\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(tags).toMatch(/flex-wrap:\s*nowrap/u);
    const tag = css.match(/\.new-bot-choice-tag\s*\{([^}]*)\}/u)?.[1] ?? "";
    expect(tag).toMatch(/text-overflow:\s*ellipsis/u);
    expect(tag).toMatch(/white-space:\s*nowrap/u);
    // A keyboard focus ring stays visible on top of the lift.
    expect(css).toMatch(/\.new-bot-choice-option:focus-visible\s*\{\s*outline:\s*2px solid/u);
  });
});
