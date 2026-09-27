// @vitest-environment happy-dom

/**
 * SetupInstallGuide — the four paths US-005 asks about:
 *  1. no coding tool installed → offer Install, run it, then guide sign-in
 *  2. tool present but not signed in → skip the install step, guide sign-in
 *  3. install fails (antivirus / offline / permission) → plain error + manual download
 *  4. signed in → the guide reaches its "done" phase, primary button is disabled
 *
 * Everything the guide can do is a prop; no adapter mocking is needed. The
 * real card (SetupIncompleteCard) is expected to wire these props through to
 * the shell adapter's install / sign-in commands.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import SetupInstallGuide, {
  type CodingTool,
  type InstallOutcome,
} from "./SetupInstallGuide.svelte";
import { NO_AI_TOOLS, type AiTools } from "./setup-launch";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  vi.clearAllMocks();
});

async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

interface RenderOpts {
  tools: AiTools | null;
  preferred?: CodingTool;
  oninstall?: (tool: CodingTool) => Promise<InstallOutcome>;
  onsignin?: (tool: CodingTool) => Promise<InstallOutcome>;
  onrefresh?: () => Promise<void>;
  downloadUrlFor?: (tool: CodingTool) => string;
  onopen?: (url: string) => Promise<InstallOutcome> | void;
}

async function render(opts: RenderOpts): Promise<{
  oninstall: ReturnType<typeof vi.fn>;
  onsignin: ReturnType<typeof vi.fn>;
  onrefresh: ReturnType<typeof vi.fn>;
  onopen: ReturnType<typeof vi.fn>;
}> {
  const oninstall = vi.fn(opts.oninstall ?? (async () => ({ ok: true })));
  const onsignin = vi.fn(opts.onsignin ?? (async () => ({ ok: true })));
  const onrefresh = vi.fn(opts.onrefresh ?? (async () => undefined));
  const onopen = vi.fn(opts.onopen ?? (() => undefined));

  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupInstallGuide, {
    target: host,
    props: {
      tools: opts.tools,
      preferred: opts.preferred ?? "claude",
      oninstall,
      onsignin,
      onrefresh,
      downloadUrlFor: opts.downloadUrlFor ?? ((tool) => `https://download.example/${tool}`),
      onopen,
    },
  });
  await settle();
  return { oninstall, onsignin, onrefresh, onopen };
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

function state(): string {
  return q('[data-testid="setup-install-guide-state"]')!.textContent ?? "";
}

function lede(): string {
  return q('[data-testid="setup-install-guide-lede"]')!.textContent ?? "";
}

describe("SetupInstallGuide — no coding tool is installed", () => {
  it("offers Install as the primary action, runs it, then guides sign-in", async () => {
    const { oninstall, onsignin, onrefresh } = await render({
      tools: { ...NO_AI_TOOLS },
    });

    // Fresh: primary says Install Claude Code, guide is idle.
    expect(state()).toBe("idle");
    const primary = q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    expect(primary.textContent).toContain("Install Claude Code");
    expect(lede()).toContain("HQ can install");

    // Install runs, guide flips to installed-need-signin, primary is now Sign in.
    primary.click();
    await vi.waitFor(() => expect(state()).toBe("installed-need-signin"));
    expect(oninstall).toHaveBeenCalledWith("claude");
    expect(onrefresh).toHaveBeenCalledTimes(1);
    expect(q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.textContent).toContain(
      "Sign in to Claude Code",
    );
    // The sign-in copy explicitly promises the password never comes to HQ.
    expect(lede()).toContain("password never comes to HQ");

    // Second click: sign-in runs and lands on done.
    q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.click();
    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(onsignin).toHaveBeenCalledWith("claude");
    expect(onrefresh).toHaveBeenCalledTimes(2);
    expect(q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.disabled).toBe(true);
  });
});

describe("SetupInstallGuide — tool present but not signed in", () => {
  it("skips the install step and offers sign-in directly", async () => {
    const tools: AiTools = { ...NO_AI_TOOLS, claude_cli: true, any: true };
    const { oninstall, onsignin } = await render({ tools });

    // Idle state, but primary already says Sign in (tool is installed).
    expect(state()).toBe("idle");
    const primary = q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    expect(primary.textContent).toContain("Sign in to Claude Code");
    expect(lede()).toContain("Claude Code is installed");

    primary.click();
    await vi.waitFor(() => expect(state()).toBe("done"));
    // Install path never fired — the guide correctly picked the right step.
    expect(oninstall).not.toHaveBeenCalled();
    expect(onsignin).toHaveBeenCalledWith("claude");
  });
});

describe("SetupInstallGuide — install fails", () => {
  it("says what happened in plain words and offers a manual download", async () => {
    const oninstall = vi.fn<(tool: CodingTool) => Promise<InstallOutcome>>(async () => ({
      ok: false,
      reason: "HQ couldn't reach the download server.",
    }));
    const opener = vi.fn(() => undefined);
    const { onrefresh } = await render({
      tools: { ...NO_AI_TOOLS },
      oninstall,
      onopen: opener,
    });

    q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.click();
    await vi.waitFor(() => expect(state()).toBe("install-failed"));

    // Plain reason surfaced; the guide does NOT show a stack or raw CLI text.
    expect(q('[data-testid="setup-install-guide-error"]')!.textContent).toContain(
      "HQ couldn't reach the download server.",
    );
    // The manual download link is the one manual step, per the brief.
    const download = q<HTMLButtonElement>('[data-testid="setup-install-guide-download"]')!;
    expect(download).toBeTruthy();
    expect(download.textContent).toContain("Download Claude Code");
    download.click();
    await settle();
    expect(opener).toHaveBeenCalledWith("https://download.example/claude");

    // The primary button retries the install (not sign-in).
    expect(
      q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.textContent,
    ).toContain("Retry installing Claude Code");
    // Refresh was not called after the failure — nothing to re-detect.
    expect(onrefresh).not.toHaveBeenCalled();
  });
});

describe("SetupInstallGuide — signed in", () => {
  it("reaches the done phase and disables the primary action", async () => {
    const tools: AiTools = { ...NO_AI_TOOLS, claude_cli: true, any: true };
    const { onsignin } = await render({
      tools,
      onsignin: vi.fn(async () => ({ ok: true })),
    });

    q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.click();
    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(onsignin).toHaveBeenCalledTimes(1);
    expect(lede()).toContain("Claude Code is ready");
    expect(q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.disabled).toBe(true);
  });
});

describe("SetupInstallGuide — safety rules", () => {
  it("never asks for or handles the user's password directly", async () => {
    // The guide's textContent (across every phase's lede) must never contain
    // password / passphrase / OTP prompts; sign-in belongs to the tool's own
    // window (US-005 hard rule).
    await render({ tools: { ...NO_AI_TOOLS } });
    const body = host.querySelector<HTMLElement>('[data-testid="setup-install-guide"]')!;
    for (const banned of ["Enter password", "enter your password", "type your password", "one-time code"]) {
      expect(body.textContent?.toLowerCase()).not.toContain(banned.toLowerCase());
    }
  });

  it("never says the OS-specific name — Windows users see the same non-mac copy", async () => {
    await render({ tools: { ...NO_AI_TOOLS } });
    const body = host.querySelector<HTMLElement>('[data-testid="setup-install-guide"]')!;
    // The install-guide lede talks about "on this computer", never "on this Mac".
    expect(body.textContent).not.toMatch(/\bMac(OS|s)?\b/i);
    expect(body.textContent).toContain("this computer");
  });

  it("checks-in-progress state renders when tools is null (host is still probing)", async () => {
    await render({ tools: null });
    expect(lede()).toContain("Checking whether Claude Code is on this computer");
    // The primary button is still callable — the install path assumes the
    // tool isn't there and offers Install as the reasonable first step.
    expect(
      q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.textContent,
    ).toContain("Install Claude Code");
  });
});
