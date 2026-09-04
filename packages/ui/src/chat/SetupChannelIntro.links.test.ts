// @vitest-environment happy-dom

// Welcome-experience contract for the synthetic #setup channel: the hero,
// the hqforwork.com resource links (getting started, book, training) plus
// the docs link, the support note, and the three launch buttons all render;
// every external link routes through `onopenurl` (system browser) instead of
// navigating the webview.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupChannelIntro from "./SetupChannelIntro.svelte";
import {
  SETUP_HERO,
  SETUP_RESOURCES,
  SETUP_SUPPORT_NOTE,
  SETUP_URLS,
  SETUP_WELCOME_MESSAGES,
} from "./setup-channel";
import { SETUP_HERO_ART } from "./setup-welcome-art";
import { NO_AI_TOOLS } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

const shell = {
  detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS })),
  openClaudeCodeLink: vi.fn(async () => ok(undefined)),
  launchClaudeCode: vi.fn(async () => ok(undefined)),
  launchCodexWorkspace: vi.fn(async () => ok(undefined)),
  launchCliInTerminal: vi.fn(async () => ok(undefined)),
};

const settings = {
  getSetupStatus: async () => ok({ hqFolderPath: "/tmp/HQ" }),
};

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountIntro(onopenurl = vi.fn()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupChannelIntro, {
    target: host,
    props: { settings, shell, onopenurl } as never,
  });
  await tick();
  await tick();
  return onopenurl;
}

describe("setup welcome copy model", () => {
  it("points at the public hqforwork.com destinations", () => {
    expect(SETUP_URLS.gettingStarted).toBe(
      "https://hqforwork.com/getting-started",
    );
    expect(SETUP_URLS.book).toBe("https://hqforwork.com/book");
    expect(SETUP_URLS.training).toBe("https://hqforwork.com/training");
    expect(SETUP_URLS.docs).toBe("https://docs.getindigo.ai");
  });

  it("lists guide, book, training, and docs as resources with https hrefs", () => {
    expect(SETUP_RESOURCES.map((r) => r.kind)).toEqual([
      "guide",
      "book",
      "training",
      "docs",
    ]);
    for (const resource of SETUP_RESOURCES) {
      expect(resource.href).toMatch(/^https:\/\//);
      expect(resource.title.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps the classic bubble sequence in lockstep with the same links", () => {
    const hrefs = SETUP_WELCOME_MESSAGES.flatMap((m) => m.links ?? []).map(
      (l) => l.href,
    );
    for (const resource of SETUP_RESOURCES) {
      expect(hrefs).toContain(resource.href);
    }
  });

  it("bundles a wallpaper for each theme", () => {
    expect(typeof SETUP_HERO_ART.dark).toBe("string");
    expect(typeof SETUP_HERO_ART.light).toBe("string");
    expect(SETUP_HERO_ART.dark).not.toBe(SETUP_HERO_ART.light);
  });
});

describe("SetupChannelIntro welcome experience", () => {
  it("renders the hero, every resource link, the support note, and the launch buttons", async () => {
    await mountIntro();

    const hero = host.querySelector('[data-testid="setup-hero"]');
    expect(hero?.textContent).toContain(SETUP_HERO.title);
    expect(hero?.textContent).toContain(SETUP_HERO.eyebrow);
    const arts = hero?.querySelectorAll<HTMLImageElement>("img.hero-art") ?? [];
    expect(arts).toHaveLength(2);
    for (const art of arts) {
      expect(art.getAttribute("alt")).toBe("");
      expect(art.getAttribute("src")).toBeTruthy();
    }

    for (const resource of SETUP_RESOURCES) {
      const link = host.querySelector<HTMLAnchorElement>(
        `[data-testid="setup-resource-${resource.id}"]`,
      );
      expect(link, `${resource.id} link renders`).toBeTruthy();
      expect(link?.getAttribute("href")).toBe(resource.href);
      expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link?.textContent).toContain(resource.title);
    }

    expect(
      host.querySelector('[data-testid="setup-support-note"]')?.textContent,
    ).toContain(SETUP_SUPPORT_NOTE);

    for (const key of ["claude", "codex", "grok"]) {
      expect(
        host.querySelector(`[data-testid="setup-launch-${key}"]`),
        `${key} launch button renders`,
      ).toBeTruthy();
    }
    expect(host.textContent).toContain("Open setup in Claude Code");
    expect(host.textContent).toContain("Open setup in Codex");
    expect(host.textContent).toContain("Open setup in Grok Build");
  });

  it("opens each resource in the system browser via onopenurl and cancels navigation", async () => {
    const onopenurl = await mountIntro();

    for (const resource of SETUP_RESOURCES) {
      const link = host.querySelector<HTMLAnchorElement>(
        `[data-testid="setup-resource-${resource.id}"]`,
      )!;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      link.dispatchEvent(event);
      expect(event.defaultPrevented, `${resource.id} cancels default`).toBe(
        true,
      );
      expect(onopenurl).toHaveBeenLastCalledWith(resource.href);
    }
    expect(onopenurl).toHaveBeenCalledTimes(SETUP_RESOURCES.length);
    expect(onopenurl).toHaveBeenCalledWith(SETUP_URLS.gettingStarted);
    expect(onopenurl).toHaveBeenCalledWith(SETUP_URLS.book);
    expect(onopenurl).toHaveBeenCalledWith(SETUP_URLS.training);
    expect(onopenurl).toHaveBeenCalledWith(SETUP_URLS.docs);
  });

  it("does not invent per-company threads inside #setup", async () => {
    await mountIntro();
    const intro = host.querySelector("[data-testid='setup-channel-intro']");
    expect(intro?.getAttribute("data-setup-threads")).toBe("none");
    expect(host.querySelector("[data-thread-key]")).toBeNull();
    expect(host.querySelector("[data-testid='company-thread-header']")).toBeNull();
  });
});
