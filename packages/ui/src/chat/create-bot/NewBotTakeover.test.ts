// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import NewBotTakeover from "./NewBotTakeover.svelte";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function takeover(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-testid="new-bot-takeover"]');
  if (!element) throw new Error("missing new bot takeover");
  return element;
}

function render(props: Record<string, unknown> = {}): void {
  host = document.createElement("div");
  host.dataset.theme = "light";
  document.body.appendChild(host);
  component = mount(NewBotTakeover, {
    target: host,
    props: {
      oncancel: vi.fn(),
      ...props,
    },
  });
}

function takeoverStyles(): string {
  return readFileSync(
    resolve(process.cwd(), "src/chat/create-bot/new-bot-takeover.css"),
    "utf8",
  );
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  document.documentElement.removeAttribute("data-theme");
});

describe("NewBotTakeover", () => {
  it("takes over the light outer app with a dark wallpaper surface and one glass card", async () => {
    document.documentElement.dataset.theme = "light";
    render({ wallpaperIndex: 2 });
    await settle();

    const dialog = takeover();
    expect(dialog.getAttribute("role")).toBe("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.style.getPropertyValue("--new-bot-wallpaper")).toContain("url(");
    expect(takeoverStyles()).toMatch(
      /\.new-bot-takeover\s*\{[\s\S]*?color-scheme:\s*dark;/,
    );
    expect(dialog.querySelectorAll(".new-bot-takeover-card")).toHaveLength(1);
  });

  it("keeps Cancel and the local-route link keyboard reachable", async () => {
    const oncancel = vi.fn();
    const onopenlocal = vi.fn();
    render({ canCreateLocalBot: true, oncancel, onopenlocal });
    await settle();

    const cancel = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-takeover-cancel"]')!;
    const local = document.querySelector<HTMLButtonElement>('[data-testid="new-bot-takeover-local"]')!;
    cancel.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(local);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(oncancel).toHaveBeenCalledOnce();
    local.click();
    expect(onopenlocal).toHaveBeenCalledOnce();
  });

  it("removes the arrival animation for people who reduce motion", () => {
    expect(takeoverStyles()).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.new-bot-takeover-card\s*\{[\s\S]*?animation:\s*none;/,
    );
  });

  it("hands a created bot into the waking screen instead of closing the takeover", async () => {
    const onwaking = vi.fn();
    render({
      companies: [{ companyUid: "cmp_acme", label: "Acme" }],
      currentCompanyUid: "cmp_acme",
      runtimeReady: { codex: true },
      loadProvisionOptions: async () => ({
        ok: true as const,
        value: {
          defaultInstanceType: "t4g.medium",
          catalogVersion: "test",
          options: [{ key: "basic" as const, productName: "Basic", instanceType: "t4g.medium", listCents: 5000, default: true, selectable: true, netMonthlyCents: 5000, deltaCents: 5000, unavailableReason: null, notBilled: false, lanes: 1, workers: 1 }],
        },
      }),
      oncreate: async () => ({ ok: true as const, target: { channelId: "chn_nova", cardId: null, cardKind: null, agentUid: "agt_nova" } }),
      getStatus: async () => ({ ok: true, value: { setupState: { phase: "creating" } } }),
      onwaking,
    });
    await settle();
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]')!;
    input.value = "Nova";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    document.querySelector<HTMLButtonElement>('[data-testid="new-bot-create-submit"]')!.click();
    await settle();

    expect(document.querySelector('[data-testid="new-bot-waking-screen"]')?.textContent).toContain("Waking up Nova");
    expect(onwaking).toHaveBeenCalledWith(expect.objectContaining({ agentUid: "agt_nova", channelId: "chn_nova" }));
  });
});
