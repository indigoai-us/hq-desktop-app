// @vitest-environment happy-dom

/**
 * The Home step's runtime section, one state at a time.
 *
 * The owner's screenshot came from this surface: "Claude Code · not signed in"
 * with a Sign in that opened nothing, on a Mac where the real problem was a
 * CLI the app could not find. These tests pin that each state gets its own
 * chip, its own sentence and its own action — and that Next is blocked for
 * exactly the states that should block it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount } from "svelte";

import CreateBotFlow from "./CreateBotFlow.svelte";
import type { RuntimeStatus } from "./runtime-status.js";

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

function click(selector: string): void {
  const el = q<HTMLButtonElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
}

/**
 * Mount the flow and walk to the Home step, with `claude` in `status`.
 *
 * `botRuntimeReady` stays false for claude in every case: that is exactly the
 * shape the old code saw, and the point is that the status — not the boolean —
 * now decides what the person reads.
 */
async function openHome(
  status: RuntimeStatus | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(CreateBotFlow, {
    target: host,
    props: {
      botRuntimeReady: { claude: false, codex: false, grok: false },
      botRuntimeStatus: status ? { claude: status, codex: status, grok: status } : null,
      botWorkers: [],
      existingNames: [],
      botCompanies: [{ slug: "indigo", label: "Indigo" }],
      previewPlacement: "top",
      oncreate: async () => undefined,
      onsignin: () => undefined,
      ...extra,
    },
  });
  await settle();
  click('[data-testid="create-bot-next"]');
  await settle();
  expect(q('[data-testid="create-bot-home-step"]')).toBeTruthy();
}

const MISSING: RuntimeStatus = { state: "notInstalled", searched: ["/opt/homebrew/bin", "/usr/local/bin"] };
const FAILED: RuntimeStatus = { state: "probeFailed", reason: "it did not answer in time" };

describe("a runtime that is not installed", () => {
  it("says so on the chip and in the footer, and offers no sign-in", async () => {
    await openHome(MISSING);

    const chip = q('[data-testid="chat-bot-runtime-claude"]')!;
    expect(chip.textContent).toContain("not installed");
    expect(chip.textContent).not.toContain("not signed in");
    expect(chip.dataset.runtimeState).toBe("notInstalled");

    const help = q('[data-testid="chat-bot-runtime-help"]')!;
    expect(help.textContent).toContain("isn’t installed on this Mac");
    expect(help.textContent).toContain("claude.ai/download");
    // The dead end from the screenshot: a Sign in that cannot succeed.
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeNull();
  });

  it("shows where HQ looked, so an unusual install is explicable", async () => {
    await openHome(MISSING);
    const searched = q('[data-testid="chat-bot-runtime-searched"]')!;
    expect(searched.textContent).toContain("/opt/homebrew/bin");
    expect(searched.textContent).toContain("/usr/local/bin");
  });

  it("offers Check again, and re-reads readiness when it is pressed", async () => {
    const onrecheckruntimes = vi.fn(async () => undefined);
    await openHome(MISSING, { onrecheckruntimes });

    click('[data-testid="chat-bot-runtime-recheck"]');
    await settle();
    expect(onrecheckruntimes).toHaveBeenCalledTimes(1);
  });

  it("blocks Next, and says which problem it is", async () => {
    await openHome(MISSING);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("isn’t installed on this Mac");
  });
});

describe("a runtime the app could not check", () => {
  it("says it could not check, names the reason, and offers a retry", async () => {
    const onrecheckruntimes = vi.fn(async () => undefined);
    await openHome(FAILED, { onrecheckruntimes });

    expect(q('[data-testid="chat-bot-runtime-claude"]')!.textContent).toContain("couldn’t check");
    const help = q('[data-testid="chat-bot-runtime-help"]')!;
    expect(help.textContent).toContain("Couldn’t check Claude Code");
    expect(help.textContent).toContain("it did not answer in time");
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeNull();

    click('[data-testid="chat-bot-runtime-recheck"]');
    await settle();
    expect(onrecheckruntimes).toHaveBeenCalledTimes(1);
  });

  it("blocks Next", async () => {
    await openHome(FAILED);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("couldn’t check");
  });
});

describe("a runtime that is installed and signed out", () => {
  it("keeps the sign-in — this is the one state it can fix", async () => {
    const onsignin = vi.fn(async () => undefined);
    await openHome({ state: "signedOut" }, { onsignin });

    expect(q('[data-testid="chat-bot-runtime-claude"]')!.textContent).toContain("not signed in");
    expect(q('[data-testid="chat-bot-runtime-help"]')!.textContent).toContain("is not signed in on this Mac");

    click('[data-testid="chat-bot-runtime-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("claude");
  });

  it("blocks Next", async () => {
    await openHome({ state: "signedOut" });
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')?.textContent).toContain("not signed in on this Mac");
  });
});

describe("a runtime that is signed in", () => {
  it("is the only state that lets the flow advance", async () => {
    await openHome({ state: "signedIn" });

    expect(q('[data-testid="chat-bot-runtime-claude"]')!.textContent).not.toContain("·");
    expect(q('[data-testid="chat-bot-runtime-help"]')!.textContent).toContain("Signed in on this Mac");
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeNull();
    expect(q('[data-testid="chat-bot-runtime-recheck"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(false);
  });
});

describe("a host that reports no status at all", () => {
  it("keeps the old boolean behaviour rather than inventing a state", async () => {
    await openHome(null);

    const chip = q('[data-testid="chat-bot-runtime-claude"]')!;
    expect(chip.textContent).toContain("not signed in");
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
  });
});
