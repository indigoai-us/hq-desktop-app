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

/** name → coding tool: the coding-tool screen is the only local step after the name. */
async function walkToHome(root: HTMLElement, settleFn: () => Promise<void>): Promise<void> {
  const name = root.querySelector<HTMLInputElement>('[data-testid="new-bot-name"]');
  if (!name) throw new Error("missing new-bot-name");
  name.value = "Dr Love";
  name.dispatchEvent(new Event("input", { bubbles: true }));
  await settleFn();
  const next = root.querySelector<HTMLButtonElement>('[data-testid="new-bot-continue-name"]');
  if (!next) throw new Error("missing new-bot-continue-name");
  next.click();
  await settleFn();
  if (!root.querySelector('[data-testid="create-bot-sunrise-home"]')) throw new Error("not on home");
}

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
      oncreate: async () => undefined,
      onsignin: () => undefined,
      ...extra,
    },
  });
  await settle();
  await walkToHome(host, () => settle());
  expect(q('[data-testid="create-bot-runtime-section"]')).toBeTruthy();
}

const MISSING: RuntimeStatus = { state: "notInstalled", searched: ["/opt/homebrew/bin", "/usr/local/bin"] };
const FAILED: RuntimeStatus = { state: "probeFailed", reason: "it did not answer in time" };

describe("a runtime that is not installed", () => {
  it("says so on the chip and in the footer, and offers no sign-in", async () => {
    await openHome(MISSING);

    const chip = q('[data-testid="chat-bot-runtime-claude"]')!;
    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Not installed");
    expect(chip.textContent).not.toContain("Sign in first");
    expect(chip.dataset.runtimeState).toBe("notInstalled");

    const help = q('[data-testid="chat-bot-runtime-help"]')!;
    expect(help.textContent).toContain("isn’t installed on this computer");
    // The fallback hint must not send a non-technical person to a terminal.
    // See the runtime-status INSTALL_HINT change (Problem 5 defence-in-depth).
    expect(help.textContent).not.toMatch(/\bnpm\b/i);
    expect(help.textContent).not.toMatch(/\bterminal\b/i);
    expect(help.textContent).not.toMatch(/claude\.ai\/download/i);
    expect(help.textContent).toContain("HQ can install it for you");
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

  it("blocks Create, and points to the panel above instead of repeating its text", async () => {
    // Problem 3 (verify-install-003 follow-up): the flow-issue footer used
    // to repeat "Claude Code isn't installed on this computer." next to
    // Next while the panel above already said the same in different words.
    // Keep ONE message; the footer now points people to the panel.
    // After the owner's review the coding tool step says it once: the card's
    // status and one line under the cards, with no second line by the buttons.
    await openHome(MISSING);
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="create-bot-issue"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="chat-bot-runtime-help"]')).toHaveLength(1);
  });
});

describe("a runtime the app could not check", () => {
  it("says it could not check, names the reason, and offers a retry", async () => {
    const onrecheckruntimes = vi.fn(async () => undefined);
    await openHome(FAILED, { onrecheckruntimes });

    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Couldn’t check");
    const help = q('[data-testid="chat-bot-runtime-help"]')!;
    expect(help.textContent).toContain("Couldn’t check Claude Code");
    expect(help.textContent).toContain("it did not answer in time");
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeNull();

    click('[data-testid="chat-bot-runtime-recheck"]');
    await settle();
    expect(onrecheckruntimes).toHaveBeenCalledTimes(1);
  });

  it("blocks Create", async () => {
    await openHome(FAILED);
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="chat-bot-runtime-help"]')?.textContent).toContain("Couldn’t check Claude Code");
    expect(q('[data-testid="create-bot-issue"]')).toBeNull();
  });
});

describe("a runtime that is installed and signed out", () => {
  it("confirms the install and offers sign-in — this is the one state it can fix", async () => {
    // After an install lands and the runtime status flips to `signedOut`,
    // the panel must confirm what happened and point to the next step.
    // Before the Problem 1 wording change the person read "is not signed
    // in" and had no way to tell whether the install had worked.
    const onsignin = vi.fn(async () => undefined);
    await openHome({ state: "signedOut" }, { onsignin });

    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Sign in first");
    const help = q('[data-testid="chat-bot-runtime-help"]')!;
    expect(help.textContent).toContain("Claude Code is installed");
    expect(help.textContent).toContain("Sign in to finish");
    // Does NOT read as "not signed in" — the panel's job in this state is
    // to look like progress, not like a fresh problem.
    expect(help.textContent).not.toContain("is not signed in on this");

    click('[data-testid="chat-bot-runtime-signin"]');
    await settle();
    expect(onsignin).toHaveBeenCalledWith("claude");
  });

  it("blocks Create, and points to the panel above", async () => {
    // The flow-issue footer must not contradict the panel above. See
    // Problem 3.
    await openHome({ state: "signedOut" });
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(true);
    expect(q('[data-testid="chat-bot-runtime-help"]')?.textContent).toContain("Sign in to finish");
    expect(q('[data-testid="create-bot-issue"]')).toBeNull();
  });
});

describe("a runtime that is signed in", () => {
  it("is the only state that lets the flow advance", async () => {
    await openHome({ state: "signedIn" });

    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Signed in");
    // The card says it; no line under the cards repeats it.
    expect(q('[data-testid="chat-bot-runtime-help"]')).toBeNull();
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeNull();
    expect(q('[data-testid="chat-bot-runtime-recheck"]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(false);
    expect(q<HTMLButtonElement>('[data-testid="create-bot-next"]')!.disabled).toBe(false);
  });
});

describe("a host that reports no status at all", () => {
  it("keeps the old boolean behaviour rather than inventing a state", async () => {
    await openHome(null);

    expect(q('[data-testid="chat-bot-runtime-claude-status"]')?.textContent).toBe("Sign in first");
    expect(q('[data-testid="chat-bot-runtime-help"]')?.textContent).toContain("not signed in");
    expect(q('[data-testid="chat-bot-runtime-signin"]')).toBeTruthy();
    expect(q<HTMLButtonElement>('[data-testid="chat-bot-create"]')!.disabled).toBe(true);
  });
});

describe("a searched list that carries repeated folders (Windows crash regression)", () => {
  // The exact shape a 64-bit Windows machine produced when the persona hit
  // the crash: `ProgramFiles` and `ProgramW6432` resolved to the same folder
  // and landed identical entries in `searched`. The wizard's keyed each
  // block used to throw `svelte.dev/e/each_key_duplicate` and replace the
  // whole app with the "Something went wrong" boundary. Any regression
  // shows up here as either a thrown error during mount or two rendered
  // <li> for the same folder.
  const REPEATED: RuntimeStatus = {
    state: "notInstalled",
    searched: [
      "C:\\Program Files\\nodejs",
      "C:\\Program Files\\nodejs",         // exact repeat
      "C:\\program files\\nodejs",         // case-only repeat
      "C:\\Program Files\\nodejs\\",       // trailing-slash repeat
      "C:\\Program Files (x86)\\nodejs",
    ],
  };

  it("renders the step and shows each folder exactly once", async () => {
    await openHome(REPEATED);

    const searched = q('[data-testid="chat-bot-runtime-searched"]');
    expect(searched).toBeTruthy();
    const items = Array.from(searched!.querySelectorAll("li")).map((li) => li.textContent ?? "");
    expect(items).toEqual([
      "C:\\Program Files\\nodejs",
      "C:\\Program Files (x86)\\nodejs",
    ]);
  });
});
