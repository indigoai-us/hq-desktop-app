// @vitest-environment happy-dom

/**
 * SetupInstallGuide - the four paths US-005 asks about:
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
  onsignin?: (tool: CodingTool, options?: { signal?: AbortSignal }) => Promise<InstallOutcome>;
  onstatus?: (tool: CodingTool) => Promise<boolean>;
  oncancelsignin?: (tool: CodingTool) => Promise<void>;
  oncontinue?: () => Promise<void> | void;
  recheckMs?: number;
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
  const extra: Record<string, unknown> = {};
  if (opts.onstatus) extra.onstatus = opts.onstatus;
  if (opts.oncancelsignin) extra.oncancelsignin = opts.oncancelsignin;
  if (opts.oncontinue) extra.oncontinue = opts.oncontinue;
  if (opts.recheckMs !== undefined) extra.recheckMs = opts.recheckMs;

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
      ...extra,
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

describe("SetupInstallGuide - no coding tool is installed", () => {
  it("offers Install as the primary action, runs it, then guides sign-in", async () => {
    const { oninstall, onsignin, onrefresh } = await render({
      tools: { ...NO_AI_TOOLS },
    });

    // Fresh: primary says Install Claude, guide is idle.
    expect(state()).toBe("idle");
    const primary = q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
    expect(primary.textContent).toBe("Install Claude");
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
    expect(onsignin.mock.calls[0]?.[0]).toBe("claude");
    expect(onrefresh).toHaveBeenCalledTimes(2);
    expect(q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.disabled).toBe(true);
  });
});

describe("SetupInstallGuide - tool present but not signed in", () => {
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
    // Install path never fired - the guide correctly picked the right step.
    expect(oninstall).not.toHaveBeenCalled();
    expect(onsignin.mock.calls[0]?.[0]).toBe("claude");
  });
});

describe("SetupInstallGuide - install fails", () => {
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
    // Refresh was not called after the failure - nothing to re-detect.
    expect(onrefresh).not.toHaveBeenCalled();
  });
});

describe("SetupInstallGuide - signed in", () => {
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

describe("SetupInstallGuide - safety rules", () => {
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

  it("names the host machine OS-aware: Mac / PC / computer, and never the wrong one", async () => {
    // Class-level regression (US-006): the lede must name the actual host
    // machine. Under a Windows probe it must never render "Mac"; under a
    // macOS probe it must never render "PC"; without a probe it falls back
    // to the neutral "this computer".
    const setHostOs = (value: string | undefined) => {
      const g = globalThis as { __HQ_HOST_OS__?: unknown; __TAURI_INTERNALS__?: unknown };
      if (value === undefined) {
        delete g.__HQ_HOST_OS__;
        delete g.__TAURI_INTERNALS__;
      } else {
        g.__HQ_HOST_OS__ = value;
        g.__TAURI_INTERNALS__ = {};
      }
    };
    try {
      setHostOs("windows");
      await render({ tools: { ...NO_AI_TOOLS } });
      let body = host.querySelector<HTMLElement>('[data-testid="setup-install-guide"]')!;
      expect(body.textContent).not.toMatch(/\bMac(OS|s)?\b/i);
      await unmount(component!);
      component = null;
      host.remove();

      setHostOs("macos");
      await render({ tools: { ...NO_AI_TOOLS } });
      body = host.querySelector<HTMLElement>('[data-testid="setup-install-guide"]')!;
      expect(body.textContent).not.toMatch(/\bPCs?\b/);
      await unmount(component!);
      component = null;
      host.remove();

      setHostOs(undefined);
      await render({ tools: { ...NO_AI_TOOLS } });
      body = host.querySelector<HTMLElement>('[data-testid="setup-install-guide"]')!;
      expect(body.textContent).toContain("this computer");
    } finally {
      setHostOs(undefined);
    }
  });

  it("checks-in-progress state renders when tools is null (host is still probing)", async () => {
    await render({ tools: null });
    expect(lede()).toContain("Checking whether Claude Code is on this computer");
    // The primary button is still callable - the install path assumes the
    // tool isn't there and offers Install as the reasonable first step.
    expect(
      q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!.textContent,
    ).toBe("Install Claude");
  });
});

function primary(): HTMLButtonElement {
  return q<HTMLButtonElement>('[data-testid="setup-install-guide-primary"]')!;
}

describe("SetupInstallGuide - choosing Claude Code or Codex", () => {
  it("offers both tools and installs and signs in to the one the person picks", async () => {
    const { oninstall, onsignin } = await render({ tools: { ...NO_AI_TOOLS } });

    const claude = q<HTMLButtonElement>('[data-testid="setup-install-guide-pick-claude"]')!;
    const codex = q<HTMLButtonElement>('[data-testid="setup-install-guide-pick-codex"]')!;
    expect(claude.textContent).toBe("Claude Code");
    expect(codex.textContent).toBe("Codex");
    expect(claude.getAttribute("aria-checked")).toBe("true");

    codex.click();
    await settle();
    expect(codex.getAttribute("aria-checked")).toBe("true");
    expect(primary().textContent).toBe("Install Codex");
    expect(lede()).toContain("HQ can install Codex");

    primary().click();
    await vi.waitFor(() => expect(state()).toBe("installed-need-signin"));
    expect(oninstall).toHaveBeenCalledWith("codex");
    expect(primary().textContent).toBe("Sign in to Codex");

    primary().click();
    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(onsignin.mock.calls[0]?.[0]).toBe("codex");
  });

  it("offers sign-in, not install, for a tool that is already on this computer", async () => {
    await render({ tools: { ...NO_AI_TOOLS, codex_cli: true, any: true } });
    q<HTMLButtonElement>('[data-testid="setup-install-guide-pick-codex"]')!.click();
    await settle();
    expect(primary().textContent).toBe("Sign in to Codex");
  });

  it("hides the picker while a step is running and once a tool is signed in", async () => {
    let finishInstall!: (outcome: InstallOutcome) => void;
    await render({
      tools: { ...NO_AI_TOOLS },
      oninstall: () => new Promise<InstallOutcome>((resolve) => (finishInstall = resolve)),
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("installing"));
    expect(q('[data-testid="setup-install-guide-picker"]')).toBeNull();
    finishInstall({ ok: true });
    await vi.waitFor(() => expect(state()).toBe("installed-need-signin"));
    expect(q('[data-testid="setup-install-guide-picker"]')).not.toBeNull();
  });
});

describe("SetupInstallGuide - install button label", () => {
  it("reads 'Install Claude' on the button and keeps 'Claude Code' in the sentence", async () => {
    await render({ tools: { ...NO_AI_TOOLS } });
    expect(primary().textContent).toBe("Install Claude");
    expect(lede()).toContain("HQ can install Claude Code");
  });
});

describe("SetupInstallGuide - noticing sign-in by itself", () => {
  it("skips straight to Continue when a coding tool is already signed in", async () => {
    const oncontinue = vi.fn(async () => undefined);
    const onstatus = vi.fn(async (tool: CodingTool) => tool === "codex");
    const { oninstall, onsignin } = await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, codex_cli: true, any: true },
      onstatus,
      oncontinue,
    });

    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(q('[data-testid="setup-install-guide"]')!.getAttribute("data-tool")).toBe("codex");
    expect(primary().textContent).toBe("Continue");
    expect(primary().disabled).toBe(false);
    expect(lede()).toContain("Codex is ready");
    expect(oninstall).not.toHaveBeenCalled();
    expect(onsignin).not.toHaveBeenCalled();
    // An existing sign-in is shown, not acted on: the person clicks Continue.
    expect(oncontinue).not.toHaveBeenCalled();

    primary().click();
    await vi.waitFor(() => expect(oncontinue).toHaveBeenCalledTimes(1));
  });

  it("keeps checking while idle and shows Continue once the sign-in lands elsewhere", async () => {
    let signedIn = false;
    const onstatus = vi.fn(async () => signedIn);
    await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onstatus,
      oncontinue: async () => undefined,
      recheckMs: 10,
    });
    expect(state()).toBe("idle");
    signedIn = true;
    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(primary().textContent).toBe("Continue");
    const calls = onstatus.mock.calls.length;
    // Once done, the checks stop.
    await new Promise((r) => setTimeout(r, 50));
    expect(onstatus.mock.calls.length).toBe(calls);
  });

  it("continues by itself after a sign-in finished in the guide", async () => {
    const oncontinue = vi.fn(async () => undefined);
    await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onstatus: async () => false,
      oncontinue,
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("done"));
    await vi.waitFor(() => expect(oncontinue).toHaveBeenCalledTimes(1));
  });

  it("keeps a Continue button to retry when continuing fails", async () => {
    const oncontinue = vi.fn(async () => {
      throw new Error("boom");
    });
    await render({ tools: { ...NO_AI_TOOLS, claude_cli: true, any: true }, oncontinue });
    primary().click();
    await vi.waitFor(() =>
      expect(q('[data-testid="setup-install-guide-continue-error"]')).not.toBeNull(),
    );
    expect(primary().textContent).toBe("Continue");
    expect(primary().disabled).toBe(false);
    expect(q('[data-testid="setup-install-guide-continue-error"]')!.textContent).not.toContain("boom");
  });
});

describe("SetupInstallGuide - waiting for the browser sign-in", () => {
  it("shows a waiting state, not a failure, while the browser sign-in is open", async () => {
    let finish!: (outcome: InstallOutcome) => void;
    await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onsignin: () => new Promise<InstallOutcome>((resolve) => (finish = resolve)),
      oncancelsignin: async () => undefined,
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("signing-in"));
    expect(q('[data-testid="setup-install-guide-error"]')).toBeNull();
    expect(lede()).toContain("in your browser");
    expect(primary().textContent).toBe("Waiting for sign-in…");
    finish({ ok: true });
    await vi.waitFor(() => expect(state()).toBe("done"));
  });

  it("'Open the sign-in page again' stops the pending sign-in and starts a fresh one", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const onsignin = vi.fn(
      (_tool: CodingTool, options?: { signal?: AbortSignal }) =>
        new Promise<InstallOutcome>((resolve) => {
          signals.push(options?.signal);
          options?.signal?.addEventListener("abort", () => resolve({ ok: false, reason: "Sign-in cancelled." }));
        }),
    );
    const oncancelsignin = vi.fn(async () => undefined);
    await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onsignin,
      oncancelsignin,
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("signing-in"));
    q<HTMLButtonElement>('[data-testid="setup-install-guide-restart-signin"]')!.click();
    await vi.waitFor(() => expect(onsignin).toHaveBeenCalledTimes(2));
    expect(oncancelsignin).toHaveBeenCalledWith("claude");
    expect(signals[0]?.aborted).toBe(true);
    // The cancelled first attempt never surfaces as a failure.
    expect(state()).toBe("signing-in");
    expect(q('[data-testid="setup-install-guide-error"]')).toBeNull();
  });
});

describe("SetupInstallGuide - recovering when sign-in did not complete", () => {
  it("offers one retry, the other tool, and notices a late sign-in", async () => {
    let signedIn = false;
    await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onsignin: async () => ({ ok: false, reason: "Sign-in timed out. Please retry." }),
      onstatus: async () => signedIn,
      oncontinue: async () => undefined,
      recheckMs: 10,
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("signin-failed"));
    expect(primary().textContent).toBe("Try signing in again");
    expect(lede()).toContain("choose Codex instead");
    expect(q('[data-testid="setup-install-guide-pick-codex"]')).not.toBeNull();
    // Only one primary action in the guide.
    expect(host.querySelectorAll("button.primary").length).toBe(1);

    // The sign-in finished after HQ stopped waiting: no dead end.
    signedIn = true;
    await vi.waitFor(() => expect(state()).toBe("done"));
    expect(primary().textContent).toBe("Continue");
  });

  it("switching to Codex after a failed sign-in offers to install Codex", async () => {
    const { oninstall } = await render({
      tools: { ...NO_AI_TOOLS, claude_cli: true, any: true },
      onsignin: async () => ({ ok: false, reason: "Sign-in did not complete." }),
    });
    primary().click();
    await vi.waitFor(() => expect(state()).toBe("signin-failed"));
    q<HTMLButtonElement>('[data-testid="setup-install-guide-pick-codex"]')!.click();
    await settle();
    expect(state()).toBe("idle");
    expect(q('[data-testid="setup-install-guide-error"]')).toBeNull();
    expect(primary().textContent).toBe("Install Codex");
    primary().click();
    await vi.waitFor(() => expect(oninstall).toHaveBeenCalledWith("codex"));
  });
});

describe("SetupInstallGuide - no empty panel", () => {
  it("does not render the assistant-app box when no assistant app is on this computer", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SetupInstallGuide, {
      target: host,
      props: {
        tools: { ...NO_AI_TOOLS },
        oninstall: async () => ({ ok: true }),
        onsignin: async () => ({ ok: true }),
        onrefresh: async () => undefined,
        downloadUrlFor: () => "",
        onopen: () => undefined,
        onopenassistant: async () => ({ ok: true }),
      },
    });
    await settle();
    expect(q('[data-testid="install-choice-panel"]')).toBeNull();
  });

  it("renders it when the ChatGPT app is on this computer", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(SetupInstallGuide, {
      target: host,
      props: {
        tools: { ...NO_AI_TOOLS, codex_desktop: true, any: true },
        oninstall: async () => ({ ok: true }),
        onsignin: async () => ({ ok: true }),
        onrefresh: async () => undefined,
        downloadUrlFor: () => "",
        onopen: () => undefined,
        onopenassistant: async () => ({ ok: true }),
      },
    });
    await settle();
    // ChatGPT is there; Claude Code (the active tool) is not installed.
    expect(q('[data-testid="install-choice-panel"]')).not.toBeNull();
  });
});
