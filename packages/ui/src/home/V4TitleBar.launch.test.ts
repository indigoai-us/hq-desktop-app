// @vitest-environment happy-dom

// Titlebar "Launch" menu: opens the HQ folder in Claude Code / Codex
// (ChatGPT) / Grok Build via the SAME cascades SetupChannelIntro uses
// (settings/launch-actions.ts), but as a PLAIN launch — no `/setup`
// prompt pre-typed. Covers: placement (left of the meetings icon),
// dropdown open, and per-item adapter dispatch.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import V4TitleBar from "./V4TitleBar.svelte";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch";

const ok = <T,>(value: T) => ({ ok: true as const, value });

function makeAdapter(
  tools: Partial<AiTools>,
  caps: { localFiles?: boolean } = {},
) {
  const shell = {
    detectAiTools: vi.fn(async () => ok({ ...NO_AI_TOOLS, ...tools })),
    openClaudeCodeLink: vi.fn(async (_url: string) => ok(undefined)),
    launchClaudeCode: vi.fn(async () => ok(undefined)),
    launchCodexWorkspace: vi.fn(async (..._args: [string, string?]) =>
      ok(undefined),
    ),
    launchCliInTerminal: vi.fn(
      async (_args: Record<string, unknown>) => ok(undefined),
    ),
  };
  return {
    kind: "desktop" as const,
    capabilities: {
      hasWindowControls: true,
      localFiles: caps.localFiles ?? true,
    },
    isAvailable: () => false,
    shell,
    files: {
      revealInFinder: vi.fn(async (_path: string) => ok(undefined)),
    },
    settings: {
      getSetupStatus: vi.fn(async () => ok({ hqFolderPath: "/tmp/HQ" })),
    },
  };
}

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountBar(
  adapter: ReturnType<typeof makeAdapter>,
  extraProps: Record<string, unknown> = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(V4TitleBar, {
    target: host,
    props: {
      adapter,
      version: "0.0.0-test",
      syncState: "idle",
      watchedCount: 0,
      ...extraProps,
    } as never,
  });
  await tick();
}

async function openMenuAndClick(
  adapter: ReturnType<typeof makeAdapter>,
  itemTestId: string,
) {
  await mountBar(adapter);
  host
    .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')
    ?.click();
  await tick();
  const item = host.querySelector<HTMLButtonElement>(
    `[data-testid="${itemTestId}"]`,
  );
  expect(item, `${itemTestId} renders`).toBeTruthy();
  item?.click();
  // Let the async folder fetch + launch cascade settle.
  await tick();
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

describe("V4TitleBar Launch menu", () => {
  it("renders the Launch button immediately to the LEFT of the meetings icon", async () => {
    await mountBar(makeAdapter({}));
    const launch = host.querySelector('[data-testid="titlebar-launch"]');
    const meetings = host.querySelector('[data-testid="titlebar-meetings"]');
    expect(launch).toBeTruthy();
    expect(meetings).toBeTruthy();
    // DOM order: Launch precedes Meetings in the same actions cluster.
    expect(
      launch!.compareDocumentPosition(meetings!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("opens a dropdown with the three tool items", async () => {
    await mountBar(makeAdapter({}));
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeNull();
    host
      .querySelector<HTMLButtonElement>('[data-testid="titlebar-launch"]')
      ?.click();
    await tick();
    const menu = host.querySelector('[data-testid="titlebar-launch-menu"]');
    expect(menu).toBeTruthy();
    // Regression (owner bug, beta.10): the menu surface must be the
    // near-opaque popover-strong convention, not a glass/translucent token —
    // nested backdrop-filter is neutered outside the titlebar's backdrop
    // root, so a translucent surface lets the channel toolbar read through.
    expect(menu?.classList.contains("v4-popover-strong-surface")).toBe(true);
    for (const key of ["claude", "codex", "grok"]) {
      expect(
        host.querySelector(`[data-testid="titlebar-launch-${key}"]`),
        `${key} item renders`,
      ).toBeTruthy();
    }
  });

  it("Claude Code: desktop deep link opens the folder WITHOUT a q prompt", async () => {
    const adapter = makeAdapter({ claude_desktop: true });
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    expect(adapter.shell.openClaudeCodeLink).toHaveBeenCalledTimes(1);
    const url = adapter.shell.openClaudeCodeLink.mock.calls[0]?.[0] ?? "";
    expect(url).toContain("claude://code/new");
    expect(url).toContain(encodeURIComponent("/tmp/HQ"));
    expect(url).not.toContain("q=");
  });

  it("Claude Code: CLI fallback launches the folder in a terminal", async () => {
    const adapter = makeAdapter({ claude_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    expect(adapter.shell.launchClaudeCode).toHaveBeenCalledWith("/tmp/HQ");
  });

  it("Codex: ChatGPT desktop app opens the workspace with NO prompt", async () => {
    const adapter = makeAdapter({ codex_desktop: true, codex_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-codex");
    expect(adapter.shell.launchCodexWorkspace).toHaveBeenCalledWith("/tmp/HQ");
    // Strict arity: no second (prompt) argument at all, so the Rust command
    // receives None and never fires the delayed codex://threads/new?prompt=
    // deep link.
    expect(adapter.shell.launchCodexWorkspace.mock.calls[0]).toEqual([
      "/tmp/HQ",
    ]);
    expect(adapter.shell.launchCliInTerminal).not.toHaveBeenCalled();
  });

  it("Codex: CLI-only machines launch codex in a terminal", async () => {
    const adapter = makeAdapter({ codex_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-codex");
    expect(adapter.shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "codex",
    });
  });

  it("Grok Build launches the grok CLI in a terminal", async () => {
    const adapter = makeAdapter({ grok_cli: true });
    await openMenuAndClick(adapter, "titlebar-launch-grok");
    expect(adapter.shell.launchCliInTerminal).toHaveBeenCalledWith({
      path: "/tmp/HQ",
      tool: "grok",
    });
    // Terminal launches carry ONLY path + tool — no prompt key of any kind.
    expect(
      Object.keys(
        adapter.shell.launchCliInTerminal.mock.calls[0]?.[0] ?? {},
      ).sort(),
    ).toEqual(["path", "tool"]);
  });

  it("renders the Console + folder actions in the cluster, between Launch and meetings", async () => {
    await mountBar(makeAdapter({}));
    const actions = host.querySelector(".v4-title-actions");
    const console_ = host.querySelector('[data-testid="titlebar-console"]');
    const folder = host.querySelector('[data-testid="titlebar-reveal-folder"]');
    const meetings = host.querySelector('[data-testid="titlebar-meetings"]');
    expect(actions?.contains(console_!)).toBe(true);
    expect(actions?.contains(folder!)).toBe(true);
    // Both sit left of the camera icon.
    for (const el of [console_, folder]) {
      expect(
        el!.compareDocumentPosition(meetings!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(console_?.getAttribute("aria-label")).toBe("Open HQ Console");
    expect(folder?.getAttribute("aria-label")).toBe("Open HQ folder");
  });

  it("Console opens https://hq.computer via the host opener, never the webview", async () => {
    const onopenurl = vi.fn();
    const beforeHref = window.location.href;
    await mountBar(makeAdapter({}), { onopenurl });
    host
      .querySelector<HTMLButtonElement>('[data-testid="titlebar-console"]')
      ?.click();
    await tick();
    expect(onopenurl).toHaveBeenCalledWith("https://hq.computer");
    // The webview must not navigate.
    expect(window.location.href).toBe(beforeHref);
  });

  it("Console falls back to a noopener window.open with no host opener", async () => {
    const open = vi
      .spyOn(window, "open")
      .mockImplementation(() => null as unknown as Window);
    await mountBar(makeAdapter({}));
    host
      .querySelector<HTMLButtonElement>('[data-testid="titlebar-console"]')
      ?.click();
    await tick();
    expect(open).toHaveBeenCalledWith(
      "https://hq.computer",
      "_blank",
      "noopener,noreferrer",
    );
    open.mockRestore();
  });

  it("Open HQ folder reveals the resolved HQ folder path in the OS file manager", async () => {
    const adapter = makeAdapter({});
    await mountBar(adapter);
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-reveal-folder"]',
      )
      ?.click();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    // The REAL resolved path from settings.getSetupStatus — not "" and not
    // undefined. A silent no-op on an unresolved path was a suspected cause
    // of the "folder button does nothing" report.
    expect(adapter.files.revealInFinder).toHaveBeenCalledWith("/tmp/HQ");
    const arg = adapter.files.revealInFinder.mock.calls[0]?.[0];
    expect(typeof arg).toBe("string");
    expect(arg).toBeTruthy();
  });

  it("surfaces the underlying reveal failure instead of swallowing it", async () => {
    const adapter = makeAdapter({});
    adapter.files.revealInFinder = vi.fn(async (_path: string) => ({
      ok: false as const,
      reason: "invoke",
      message: "Command reveal_in_finder not found",
    })) as never;
    await mountBar(adapter);
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-reveal-folder"]',
      )
      ?.click();
    await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    // The tooltip must carry the real reason — a generic string is what hid
    // the command-name bug in the first place.
    const btn = host.querySelector('[data-testid="titlebar-reveal-folder"]');
    btn?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await tick();
    const bubble = host.querySelector('[data-testid="tooltip-bubble"]');
    expect(bubble?.textContent).toContain("Could not open HQ folder");
    expect(bubble?.textContent).toContain("reveal_in_finder not found");
  });
});

describe("V4TitleBar cluster tooltips", () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ["titlebar-launch", "Open your HQ folder in an AI tool"],
    ["titlebar-reveal-folder", "Open HQ folder"],
    ["titlebar-console", "Open HQ Console"],
    ["titlebar-meetings", "Meetings"],
    ["titlebar-notifications", "Notifications"],
  ];

  it("shows a styled tooltip immediately on keyboard focus, wired via aria-describedby", async () => {
    for (const [testid, label] of CASES) {
      await mountBar(makeAdapter({}));
      const btn = host.querySelector<HTMLButtonElement>(
        `[data-testid="${testid}"]`,
      );
      expect(btn, `${testid} renders`).toBeTruthy();
      // No native title attribute — these are styled tooltips now.
      expect(btn?.hasAttribute("title")).toBe(false);
      btn?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await tick();
      const bubble = host.querySelector('[data-testid="tooltip-bubble"]');
      expect(bubble?.textContent?.trim(), `${testid} tooltip text`).toBe(label);
      expect(bubble?.getAttribute("role")).toBe("tooltip");
      // a11y: the trigger points at the bubble that describes it.
      expect(btn?.getAttribute("aria-describedby")).toBe(bubble?.id);

      // Blur hides it again.
      btn?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
      await tick();
      expect(host.querySelector('[data-testid="tooltip-bubble"]')).toBeNull();

      if (component) await unmount(component);
      component = null;
      host.remove();
    }
  });

  it("renders both pill carets as centered SVG geometry, not the low-hanging ⌄ glyph", async () => {
    // The Core pill only renders on hosts with sync/update/package support.
    const adapter = makeAdapter({});
    adapter.isAvailable = () => true;
    await mountBar(adapter);
    // Both dropdown pills (Launch + Core) must use the same caret treatment
    // so they stay visually consistent.
    for (const testid of ["titlebar-launch", "titlebar-core-pill"]) {
      const pill = host.querySelector(`[data-testid="${testid}"]`);
      expect(pill, `${testid} renders`).toBeTruthy();
      const caret = pill?.querySelector(".v4-core-caret");
      expect(caret, `${testid} has a caret`).toBeTruthy();
      // Geometry, not a text glyph: U+2304 DOWN ARROWHEAD draws its ink low
      // in the em box, so flex centering could never optically centre it.
      expect(caret?.tagName.toLowerCase()).toBe("svg");
      expect(pill?.textContent ?? "").not.toContain("⌄");
      // Ink is centred in the viewBox (x 2.5→7.5, y 4→6.5 in a 10×10 box),
      // which is what makes the optical centre match the label's.
      expect(caret?.getAttribute("viewBox")).toBe("0 0 10 10");
      // currentColor keeps dark/light working without an override.
      expect(caret?.querySelector("path")?.getAttribute("stroke")).toBe(
        "currentColor",
      );
    }
  });

  it("waits for the hover dwell delay before showing on pointer enter", async () => {
    vi.useFakeTimers();
    try {
      await mountBar(makeAdapter({}));
      const btn = host.querySelector<HTMLButtonElement>(
        '[data-testid="titlebar-console"]',
      );
      btn?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: true }));
      await tick();
      // Not yet — the dwell delay has not elapsed.
      expect(host.querySelector('[data-testid="tooltip-bubble"]')).toBeNull();
      vi.advanceTimersByTime(400);
      await tick();
      expect(
        host.querySelector('[data-testid="tooltip-bubble"]')?.textContent,
      ).toContain("Open HQ Console");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the folder action on hosts without local file support (web)", async () => {
    await mountBar(makeAdapter({}, { localFiles: false }));
    expect(
      host.querySelector('[data-testid="titlebar-reveal-folder"]'),
    ).toBeNull();
    // The Console link is host-agnostic and stays.
    expect(host.querySelector('[data-testid="titlebar-console"]')).toBeTruthy();
  });

  it("shows a per-item error and keeps the menu open when a launch fails", async () => {
    const adapter = makeAdapter({});
    // No tools detected at all → prompt-free "not detected" copy (no /setup).
    await openMenuAndClick(adapter, "titlebar-launch-claude");
    const error = host.querySelector(
      '[data-testid="titlebar-launch-claude-error"]',
    );
    expect(error?.textContent).toContain("Claude Code was not detected");
    expect(error?.textContent).not.toContain("/setup");
    expect(
      host.querySelector('[data-testid="titlebar-launch-menu"]'),
    ).toBeTruthy();
  });
});
