// @vitest-environment happy-dom

// The setup run card's faces: running with the stepper, a choice question, a
// free-text question, a permission ask, done, stopped, and resume. No command
// or tool text ever reaches the screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mount, tick, unmount, type ComponentProps } from "svelte";

import SetupRunCard from "./SetupRunCard.svelte";
import { SETUP_RUN_DONE, SETUP_RUN_STEPS, SETUP_RUN_STOPPED, interpretSetupRun, type SetupRunEvent } from "./setup-run";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

async function mountCard(props: ComponentProps<typeof SetupRunCard>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SetupRunCard, { target: host, props });
  await tick();
}

const say = (text: string): SetupRunEvent => ({ kind: "assistantMessage", text });
const turnDone: SetupRunEvent = { kind: "turnDone", status: "success" };

function stepStatuses(): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>("[data-step-status]")).map(
    (el) => el.dataset.stepStatus ?? "",
  );
}

describe("SetupRunCard", () => {
  it("renders the six steps in order with the running step's status line", async () => {
    const run = interpretSetupRun(
      [say("Checking what's already in place."), say("Signed in as jacob@example.com — synced.")],
      "working",
    );
    await mountCard({ mode: "live", run });
    const labels = Array.from(host.querySelectorAll(".step-label")).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Tools", "HQ Cloud", "Import", "About you", "Connect", "Your first moves"]);
    expect(stepStatuses()).toEqual(["done", "running", "pending", "pending", "pending", "pending"]);
    expect(host.querySelector('[data-testid="setup-run-status"]')?.textContent?.trim()).toBe(
      "Signed in as jacob@example.com — synced.",
    );
    expect(host.querySelector('[data-testid="setup-run-question"]')).toBeNull();
    expect(host.querySelector('[data-testid="setup-run-card"]')?.getAttribute("data-setup-run-mode")).toBe("live");
  });

  it("renders a choice question as buttons and answers on click", async () => {
    const onanswer = vi.fn();
    const run = interpretSetupRun(
      [
        {
          kind: "questionRequest",
          requestId: "req-1",
          questions: [
            {
              id: "q1",
              text: "What do you want help with first?",
              options: [{ label: "Marketing", description: "Content" }, { label: "Engineering" }],
            },
          ],
        },
      ],
      "needsYou",
    );
    await mountCard({ mode: "live", run, onanswer });
    const question = host.querySelector<HTMLElement>('[data-testid="setup-run-question"]');
    expect(question?.dataset.questionKind).toBe("choice");
    expect(question?.textContent).toContain("What do you want help with first?");
    const choices = host.querySelectorAll<HTMLButtonElement>('[data-testid="setup-run-choice"]');
    expect(choices).toHaveLength(2);
    // An option with a description turns the row into a stacked list.
    expect(choices[0]!.parentElement?.classList.contains("choices--stacked")).toBe(true);
    choices[1]!.click();
    expect(onanswer).toHaveBeenCalledWith("req-1", "q1", ["Engineering"]);
  });

  it("a choice question still takes a typed answer, like the CLI's Other row", async () => {
    const onanswer = vi.fn();
    const run = interpretSetupRun(
      [
        {
          kind: "questionRequest",
          requestId: "req-1",
          questions: [
            {
              id: "q1",
              text: "What's your name?",
              options: [{ label: "Type it in" }, { label: "Skip for now" }],
            },
          ],
        },
      ],
      "needsYou",
    );
    await mountCard({ mode: "live", run, onanswer });
    const input = host.querySelector<HTMLInputElement>('[data-testid="setup-run-answer"]');
    expect(input).not.toBeNull();
    input!.value = "Jacob";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    const send = host.querySelector<HTMLButtonElement>('[data-testid="setup-run-send"]');
    expect(send?.disabled).toBe(false);
    send!.click();
    expect(onanswer).toHaveBeenCalledWith("req-1", "q1", ["Jacob"]);
  });

  it("collects a multi-select choice and sends the picked labels together", async () => {
    const onanswer = vi.fn();
    const run = interpretSetupRun(
      [
        {
          kind: "questionRequest",
          requestId: "req-2",
          questions: [
            { id: "q2", text: "Which tools do you use?", options: [{ label: "Slack" }, { label: "Linear" }], multiSelect: true },
          ],
        },
      ],
      "needsYou",
    );
    await mountCard({ mode: "live", run, onanswer });
    const choices = host.querySelectorAll<HTMLButtonElement>('[data-testid="setup-run-choice"]');
    choices[0]!.click();
    choices[1]!.click();
    await tick();
    expect(onanswer).not.toHaveBeenCalled();
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-send-choices"]')!.click();
    expect(onanswer).toHaveBeenCalledWith("req-2", "q2", ["Slack", "Linear"]);
  });

  it("renders a trailing question as a text field and sends the typed answer", async () => {
    const onsend = vi.fn();
    const run = interpretSetupRun([say("Now let's get to know you.\n\n**What's your name?**"), turnDone], "idle");
    await mountCard({ mode: "live", run, onsend });
    const question = host.querySelector<HTMLElement>('[data-testid="setup-run-question"]');
    expect(question?.dataset.questionKind).toBe("text");
    expect(question?.textContent).toContain("What's your name?");
    expect(question?.textContent).not.toContain("**");
    const input = host.querySelector<HTMLInputElement>('[data-testid="setup-run-answer"]');
    const send = host.querySelector<HTMLButtonElement>('[data-testid="setup-run-send"]');
    expect(send?.disabled).toBe(true);
    input!.value = "Jacob";
    input!.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    expect(send?.disabled).toBe(false);
    input!.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onsend).toHaveBeenCalledWith("Jacob");
  });

  it("renders a permission ask in plain words and reports the decision", async () => {
    const onpermission = vi.fn();
    const run = interpretSetupRun(
      [say("Checking what's already in place."), { kind: "permissionRequest", requestId: "perm-1", toolName: "Bash" }],
      "needsYou",
    );
    await mountCard({ mode: "live", run, onpermission });
    expect(host.textContent).not.toContain("Bash");
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-allow-session"]')!.click();
    expect(onpermission).toHaveBeenCalledWith("perm-1", "allowSession");
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-deny"]')!.click();
    expect(onpermission).toHaveBeenLastCalledWith("perm-1", "deny");
  });

  it("shows the done state with every step ticked and a summary", async () => {
    const run = interpretSetupRun([say("You're all set — here's your welcome page (private to you): https://x.example/w"), turnDone], "idle");
    await mountCard({ mode: "live", run, onshowdetails: vi.fn() });
    expect(host.querySelector('[data-testid="setup-run-done-title"]')?.textContent).toBe(SETUP_RUN_DONE.title);
    expect(host.querySelector('[data-testid="setup-run-summary"]')?.textContent).toBe(SETUP_RUN_DONE.summary);
    expect(stepStatuses()).toEqual(["done", "done", "done", "done", "done", "done"]);
    expect(host.querySelector('[data-testid="setup-run-question"]')).toBeNull();
    expect(host.textContent).not.toContain("https://");
  });

  it("offers Run Setup again when the session stopped early", async () => {
    const onrunagain = vi.fn();
    const run = interpretSetupRun([say("Checking tools."), { kind: "exited", code: 1 }], "ended");
    await mountCard({ mode: "live", run, onrunagain });
    expect(host.querySelector('[data-testid="setup-run-stopped-title"]')?.textContent).toBe(SETUP_RUN_STOPPED.title);
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-again"]')!.click();
    expect(onrunagain).toHaveBeenCalledOnce();
  });

  it("offers Continue setup (N of 6) in resume mode with the remembered step lit", async () => {
    const oncontinue = vi.fn();
    await mountCard({ mode: "resume", resumeStep: 2, oncontinue, onshowdetails: vi.fn() });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="setup-run-continue"]');
    expect(button?.textContent?.trim()).toBe("Continue setup (3 of 6)");
    expect(stepStatuses()).toEqual(["done", "done", "running", "pending", "pending", "pending"]);
    // Details are only meaningful once re-attached.
    expect(host.querySelector('[data-testid="setup-run-details"]')).toBeNull();
    button!.click();
    expect(oncontinue).toHaveBeenCalledOnce();
  });

  it("Show details calls back and disables controls while busy", async () => {
    const onshowdetails = vi.fn();
    const run = interpretSetupRun([say("**What's your name?**"), turnDone], "idle");
    await mountCard({ mode: "live", run, busy: true, onshowdetails, error: "Could not reach the session." });
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-details"]')!.click();
    expect(onshowdetails).toHaveBeenCalledOnce();
    expect(host.querySelector<HTMLInputElement>('[data-testid="setup-run-answer"]')?.disabled).toBe(true);
    expect(host.querySelector('[data-testid="setup-run-error"]')?.textContent).toBe("Could not reach the session.");
  });
});

describe("SetupRunCard remembered outcome", () => {
  it("the done face shows every step complete and offers Run again", async () => {
    const onrunagain = vi.fn();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const component = mount(SetupRunCard, { target: host, props: { mode: "done", onrunagain } as never });
    await tick();
    const card = host.querySelector('[data-testid="setup-run-card"]') as HTMLElement;
    expect(card.dataset.setupRunMode).toBe("done");
    expect(host.querySelectorAll(".step--done").length).toBe(SETUP_RUN_STEPS.length);
    expect(host.querySelector('[data-testid="setup-run-continue"]')).toBeNull();
    (host.querySelector('[data-testid="setup-run-again"]') as HTMLButtonElement).click();
    expect(onrunagain).toHaveBeenCalledOnce();
    unmount(component);
    host.remove();
  });
});

describe("SetupRunCard guided cards", () => {
  const cardRun = (cardJson: string, header: string, options: string[], multiSelect = false) =>
    interpretSetupRun(
      [
        { kind: "assistantMessage", text: `[hq-setup] card=${cardJson}` },
        {
          kind: "questionRequest",
          requestId: "req-1",
          questions: [{ id: "q1", header, text: `${header}?`, options: options.map((label) => ({ label })), multiSelect }],
        },
      ],
      "needsYou",
    );

  it("the found card lists what the scan turned up above the import choices", async () => {
    const run = cardRun('{"kind":"found","items":[{"label":"Claude Code sessions","count":12},{"label":"Plans","count":3}]}', "Import", ["Import now", "Skip"]);
    await mountCard({ mode: "live", run, onanswer: vi.fn() });
    const found = host.querySelector('[data-testid="setup-run-found"]');
    expect(found?.textContent).toContain("12");
    expect(found?.textContent).toContain("Claude Code sessions");
    expect(host.querySelectorAll('[data-testid="setup-run-choice"]')).toHaveLength(2);
  });

  it("the integrations card shows app tiles, connected ones locked, and connects the picked names", async () => {
    const onanswer = vi.fn();
    const run = cardRun(
      '{"kind":"integrations","items":[{"name":"Linear","auth":"oauth"},{"name":"GitHub","status":"connected"},{"name":"Notion","auth":"key"}]}',
      "Integrations",
      ["Linear", "GitHub", "Notion", "Skip for now"],
      true,
    );
    await mountCard({ mode: "live", run, onanswer });
    const apps = host.querySelectorAll<HTMLButtonElement>('[data-testid="setup-run-app"]');
    expect(apps).toHaveLength(3);
    expect(apps[1]!.disabled).toBe(true);
    expect(apps[1]!.dataset.appStatus).toBe("connected");
    apps[0]!.click();
    apps[2]!.click();
    await tick();
    const send = host.querySelector<HTMLButtonElement>('[data-testid="setup-run-send-choices"]');
    expect(send?.textContent?.trim()).toBe("Connect 2 apps");
    send!.click();
    expect(onanswer).toHaveBeenCalledWith("req-1", "q1", ["Linear", "Notion"]);
    // Skip stays available as a plain choice.
    const spare = Array.from(host.querySelectorAll('[data-testid="setup-run-choice"]')).map((el) => el.textContent?.trim());
    expect(spare).toEqual(["Skip for now"]);
  });

  it("the secret card stores through the host and answers Done, never sending the value as text", async () => {
    const onanswer = vi.fn();
    const onsend = vi.fn();
    const onstoresecret = vi.fn(async () => {});
    const run = cardRun('{"kind":"secret","name":"DATABASE_URL","label":"Postgres connection string","scope":"company","company":"hqtestco"}', "Secret", ["Done", "Skip"]);
    await mountCard({ mode: "live", run, onanswer, onsend, onstoresecret });
    const input = host.querySelector<HTMLInputElement>('[data-testid="setup-run-secret-input"]')!;
    expect(input.type).toBe("password");
    expect(host.querySelector('[data-testid="setup-run-secret"]')?.textContent).toContain("hqtestco vault");
    input.value = "postgres://user:pw@host/db";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-secret-store"]')!.click();
    await tick();
    await Promise.resolve();
    await tick();
    expect(onstoresecret).toHaveBeenCalledWith(expect.objectContaining({ kind: "secret", name: "DATABASE_URL" }), "postgres://user:pw@host/db");
    expect(onanswer).toHaveBeenCalledWith("req-1", "q1", ["Done"]);
    expect(onsend).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLInputElement>('[data-testid="setup-run-secret-input"]')?.value ?? "").toBe("");
  });

  it("a failed store shows the message and leaves the question open", async () => {
    const onanswer = vi.fn();
    const onstoresecret = vi.fn(async () => {
      throw new Error("HQ could not reach the vault.");
    });
    const run = cardRun('{"kind":"secret","name":"API_KEY"}', "Secret", ["Done", "Skip"]);
    await mountCard({ mode: "live", run, onanswer, onstoresecret });
    const input = host.querySelector<HTMLInputElement>('[data-testid="setup-run-secret-input"]')!;
    input.value = "sk-test";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await tick();
    host.querySelector<HTMLButtonElement>('[data-testid="setup-run-secret-store"]')!.click();
    await tick();
    await Promise.resolve();
    await tick();
    expect(host.querySelector('[data-testid="setup-run-secret-error"]')?.textContent).toContain("could not reach the vault");
    expect(onanswer).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="setup-run-choice"]')?.textContent?.trim()).toBe("Skip");
  });

  it("without a host that can store secrets the plain choices show instead", async () => {
    const run = cardRun('{"kind":"secret","name":"API_KEY"}', "Secret", ["Done", "Skip"]);
    await mountCard({ mode: "live", run, onanswer: vi.fn() });
    expect(host.querySelector('[data-testid="setup-run-secret"]')).toBeNull();
    expect(host.querySelectorAll('[data-testid="setup-run-choice"]')).toHaveLength(2);
  });
});
