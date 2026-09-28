// @vitest-environment happy-dom

/**
 * The shared install-choice panel, rendered.
 *
 * Every state gets its own test:
 *   - Claude Desktop present → "Set up with Claude" is offered and
 *     dispatches the correct `claude://code/new?q=…&folder=` URL.
 *   - ChatGPT desktop present → "Set up with ChatGPT" is offered and
 *     dispatches `codex://threads/new?prompt=…`.
 *   - Neither present → only the direct-install fallback shows.
 *   - Tools probing → no buttons, a plain "Checking…" line.
 *   - Failed dispatch → surfaces a plain-language error, keeps the retry.
 *
 * The main text NEVER shows a terminal command, `npm`, or "CLI" — this is
 * the operator's rule and it is pinned here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import InstallChoice from "./InstallChoice.svelte";
import { NO_AI_TOOLS, type AiTools } from "../settings/setup-launch.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function q<T extends Element = HTMLElement>(selector: string): T | null {
  return host.querySelector<T>(selector);
}

interface Opts {
  tools?: AiTools | null;
  tool?: "claude" | "codex";
  noun?: string;
  hqFolder?: string;
  onopenassistant?: ReturnType<typeof vi.fn>;
  oninstall?: ReturnType<typeof vi.fn>;
  onrecheck?: ReturnType<typeof vi.fn>;
}

async function render(opts: Opts = {}): Promise<{
  onopenassistant: ReturnType<typeof vi.fn>;
  oninstall: ReturnType<typeof vi.fn>;
  onrecheck: ReturnType<typeof vi.fn>;
}> {
  const onopenassistant = opts.onopenassistant ?? vi.fn(async () => ({ ok: true }));
  const oninstall = opts.oninstall ?? vi.fn(async () => ({ ok: true }));
  const onrecheck = opts.onrecheck ?? vi.fn(async () => undefined);
  host = document.createElement("div");
  document.body.appendChild(host);
  // Preserve an explicit `null` for `tools` so the probing state can be
  // tested; `??` would fall through to `NO_AI_TOOLS`.
  const toolsProp: AiTools | null =
    "tools" in opts && opts.tools !== undefined ? opts.tools : NO_AI_TOOLS;
  component = mount(InstallChoice, {
    target: host,
    // Cast to `never` at the boundary because `vi.fn()`'s inferred type is
    // wider than the callback shape InstallChoice declares. The vi.fn is a
    // callable; TS just can't see through the mock instance's overloads.
    props: {
      tool: opts.tool ?? "claude",
      tools: toolsProp,
      noun: opts.noun ?? "Mac",
      hqFolder: opts.hqFolder ?? "",
      onopenassistant: onopenassistant as never,
      oninstall: oninstall as never,
      onrecheck: onrecheck as never,
    },
  });
  await settle();
  return { onopenassistant, oninstall, onrecheck };
}

const CLAUDE_ONLY: AiTools = { ...NO_AI_TOOLS, claude_desktop: true, any: true };
const CHATGPT_ONLY: AiTools = { ...NO_AI_TOOLS, codex_desktop: true, any: true };
const BOTH: AiTools = {
  ...NO_AI_TOOLS,
  claude_desktop: true,
  codex_desktop: true,
  any: true,
};

describe("InstallChoice — plain wording that never names a command", () => {
  it("never mentions npm, CLI, terminal, or a file path in its lede", async () => {
    await render({ tools: CLAUDE_ONLY });
    const lede = q('[data-testid="install-choice-lede"]')!.textContent!;
    expect(lede).not.toMatch(/\bnpm\b/i);
    expect(lede).not.toMatch(/\bCLI\b/);
    expect(lede).not.toMatch(/\bterminal\b/i);
    // No file paths in the lede.
    expect(lede).not.toMatch(/\//);
    expect(lede).not.toMatch(/[A-Z]:\\/);
  });

  it("names the machine 'Mac' on macOS", async () => {
    await render({ tools: CLAUDE_ONLY, noun: "Mac" });
    expect(q('[data-testid="install-choice-lede"]')!.textContent).toContain(
      "this Mac",
    );
  });

  it("says 'PC' on Windows and never 'Mac'", async () => {
    await render({ tools: CLAUDE_ONLY, noun: "PC" });
    const lede = q('[data-testid="install-choice-lede"]')!.textContent!;
    expect(lede).toContain("this PC");
    expect(lede).not.toMatch(/\bMac\b/);
  });
});

describe("InstallChoice — Claude Desktop is here (Claude Code case)", () => {
  it("offers 'Set up with Claude' and dispatches the deep link", async () => {
    const { onopenassistant } = await render({
      tools: CLAUDE_ONLY,
      tool: "claude",
      hqFolder: "/Users/me/HQ",
    });
    const btn = q<HTMLButtonElement>('[data-testid="install-choice-open-claude"]');
    expect(btn).toBeTruthy();
    expect(btn!.textContent).toContain("Set up with Claude");
    btn!.click();
    await settle();
    expect(onopenassistant).toHaveBeenCalledTimes(1);
    const [assistant, url] = onopenassistant.mock.calls[0];
    expect(assistant).toBe("claude-desktop");
    expect(url).toMatch(/^claude:\/\/code\/new\?/);
    const parsed = new URL(url);
    expect(parsed.searchParams.get("q")).toContain("HQ");
    expect(parsed.searchParams.get("folder")).toBe("/Users/me/HQ");
  });

  it("does NOT offer ChatGPT when only Claude Desktop is here", async () => {
    await render({ tools: CLAUDE_ONLY });
    expect(q('[data-testid="install-choice-open-chatgpt"]')).toBeNull();
  });

  it("still surfaces the direct-install fallback below the assistant button", async () => {
    await render({ tools: CLAUDE_ONLY });
    expect(q('[data-testid="install-choice-install-claude"]')).toBeTruthy();
  });
});

describe("InstallChoice — ChatGPT desktop is here (Codex case)", () => {
  it("offers 'Set up with ChatGPT' and dispatches the codex:// link", async () => {
    const { onopenassistant } = await render({
      tools: CHATGPT_ONLY,
      tool: "codex",
    });
    const btn = q<HTMLButtonElement>('[data-testid="install-choice-open-chatgpt"]');
    expect(btn).toBeTruthy();
    btn!.click();
    await settle();
    expect(onopenassistant).toHaveBeenCalledTimes(1);
    const [assistant, url] = onopenassistant.mock.calls[0];
    expect(assistant).toBe("chatgpt-desktop");
    expect(url).toMatch(/^codex:\/\/threads\/new\?/);
  });
});

describe("InstallChoice — both assistants are here", () => {
  it("offers both buttons; the tool's native assistant is primary", async () => {
    await render({ tools: BOTH, tool: "claude" });
    const claudeBtn = q<HTMLButtonElement>(
      '[data-testid="install-choice-open-claude"]',
    );
    const chatgptBtn = q<HTMLButtonElement>(
      '[data-testid="install-choice-open-chatgpt"]',
    );
    expect(claudeBtn).toBeTruthy();
    expect(chatgptBtn).toBeTruthy();
    expect(claudeBtn!.classList.contains("primary")).toBe(true);
    expect(chatgptBtn!.classList.contains("primary")).toBe(false);
  });
});

describe("InstallChoice — no assistant app is here", () => {
  it("hides both assistant buttons and offers only the direct install", async () => {
    await render({ tools: NO_AI_TOOLS });
    expect(q('[data-testid="install-choice-open-claude"]')).toBeNull();
    expect(q('[data-testid="install-choice-open-chatgpt"]')).toBeNull();
    expect(q('[data-testid="install-choice-install-claude"]')).toBeTruthy();
  });

  it("keeps 'Check again' next to any assisted-recovery button (repo policy)", async () => {
    await render({ tools: NO_AI_TOOLS });
    // Direct retry stays visible per
    // policy `hq-desktop-app-failed-state-assisted-recovery-preserve-retry`.
    expect(q('[data-testid="install-choice-recheck"]')).toBeTruthy();
  });

  it("clicking Check again re-runs the parent's onrecheck", async () => {
    const { onrecheck } = await render({ tools: NO_AI_TOOLS });
    q<HTMLButtonElement>('[data-testid="install-choice-recheck"]')!.click();
    await settle();
    expect(onrecheck).toHaveBeenCalledTimes(1);
  });
});

describe("InstallChoice — detection is still running", () => {
  it("renders a neutral 'Checking…' line and NO buttons yet", async () => {
    await render({ tools: null });
    expect(q('[data-testid="install-choice-probing"]')).toBeTruthy();
    expect(q('[data-testid="install-choice-open-claude"]')).toBeNull();
    expect(q('[data-testid="install-choice-open-chatgpt"]')).toBeNull();
    expect(q('[data-testid="install-choice-install-claude"]')).toBeNull();
  });
});

describe("InstallChoice — dispatch failure surfaces a plain error and keeps retry", () => {
  it("surfaces the assistant dispatcher's reason and does NOT hide Check again", async () => {
    const onopenassistant = vi.fn(async () => ({
      ok: false,
      reason: "Claude did not respond.",
    }));
    await render({ tools: CLAUDE_ONLY, onopenassistant });
    q<HTMLButtonElement>('[data-testid="install-choice-open-claude"]')!.click();
    await settle();
    expect(q('[data-testid="install-choice-error"]')?.textContent).toContain(
      "Claude did not respond.",
    );
    expect(q('[data-testid="install-choice-recheck"]')).toBeTruthy();
  });
});

describe("InstallChoice — one-click install completes without a manual re-check", () => {
  /**
   * The Windows test persona (`verify-install-003`) reported the exact bug
   * this test guards: clicking "Install Claude Code" sat on "Working…" for
   * 30-40 s, then the button label snapped back to "Install Claude Code"
   * with no confirmation. They only discovered the install had worked by
   * pressing "Check again" — a step the panel now owns.
   */
  it("shows a plain 'about a minute' progress line while the installer runs", async () => {
    // A slow install so the test can observe the intermediate state without
    // relying on a debouncing timer.
    let resolveInstall: ((v: { ok: boolean }) => void) | null = null;
    const oninstall = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((r) => {
          resolveInstall = r;
        }),
    );
    await render({ tools: NO_AI_TOOLS, oninstall });
    q<HTMLButtonElement>('[data-testid="install-choice-install-claude"]')!.click();
    await settle();
    const status = q('[data-testid="install-choice-status"]');
    expect(status).toBeTruthy();
    expect(status!.textContent).toContain("Installing Claude Code");
    // No CLI wording ever, in any state.
    expect(status!.textContent).not.toMatch(/\bnpm\b/i);
    expect(status!.textContent).not.toMatch(/\bCLI\b/);
    expect(status!.textContent).not.toMatch(/\bterminal\b/i);
    // Approximate-duration hint present, so the person does not conclude
    // it has hung.
    expect(status!.textContent!.toLowerCase()).toContain("about a minute");
    // Button reads "Installing…", not the bare "Working…" the persona saw.
    const btn = q<HTMLButtonElement>('[data-testid="install-choice-install-claude"]');
    expect(btn!.textContent!.trim()).toBe("Installing…");
    resolveInstall!({ ok: true });
    await settle();
  });

  it("auto-runs the parent's re-check when the installer resolves ok", async () => {
    const oninstall = vi.fn(async () => ({ ok: true }));
    const onrecheck = vi.fn(async () => undefined);
    await render({ tools: NO_AI_TOOLS, oninstall, onrecheck });
    q<HTMLButtonElement>('[data-testid="install-choice-install-claude"]')!.click();
    await settle();
    expect(oninstall).toHaveBeenCalledTimes(1);
    // The whole point: the panel calls `onrecheck` on its own, so the parent
    // status flips to `signedOut` without a "Check again" click.
    expect(onrecheck).toHaveBeenCalledTimes(1);
    // And the person sees a confirmation line while the parent's status
    // probe runs.
    const status = q('[data-testid="install-choice-status"]');
    expect(status?.textContent).toContain("Claude Code is installed");
  });

  it("on install failure, shows the plain reason AND keeps install + Check again", async () => {
    const oninstall = vi.fn(async () => ({
      ok: false,
      reason:
        "HQ couldn't reach the internet to install Claude Code. Check the network and try again.",
    }));
    const onrecheck = vi.fn(async () => undefined);
    await render({ tools: NO_AI_TOOLS, oninstall, onrecheck });
    q<HTMLButtonElement>('[data-testid="install-choice-install-claude"]')!.click();
    await settle();
    const err = q('[data-testid="install-choice-error"]');
    expect(err).toBeTruthy();
    expect(err!.textContent).toContain("Check the network");
    // Install button + Check again both stayed. The panel never dead-ends.
    expect(q('[data-testid="install-choice-install-claude"]')).toBeTruthy();
    expect(q('[data-testid="install-choice-recheck"]')).toBeTruthy();
    // A failed install must NOT auto-run re-check — a re-check would silently
    // overwrite the error and the person would never learn why it failed.
    expect(onrecheck).toHaveBeenCalledTimes(0);
  });
});
