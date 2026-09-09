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
  it("renders the four steps in order with the running step's status line", async () => {
    const run = interpretSetupRun(
      [say("Checking what's already in place."), say("Signed in as jacob@example.com — synced.")],
      "working",
    );
    await mountCard({ mode: "live", run });
    const labels = Array.from(host.querySelectorAll(".step-label")).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Tools", "HQ Cloud", "About you", "Your first moves"]);
    expect(stepStatuses()).toEqual(["done", "running", "pending", "pending"]);
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
    expect(host.querySelector('[data-testid="setup-run-answer"]')).toBeNull();
    choices[1]!.click();
    expect(onanswer).toHaveBeenCalledWith("req-1", "q1", ["Engineering"]);
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
    expect(stepStatuses()).toEqual(["done", "done", "done", "done"]);
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

  it("offers Continue setup (N of 4) in resume mode with the remembered step lit", async () => {
    const oncontinue = vi.fn();
    await mountCard({ mode: "resume", resumeStep: 2, oncontinue, onshowdetails: vi.fn() });
    const button = host.querySelector<HTMLButtonElement>('[data-testid="setup-run-continue"]');
    expect(button?.textContent?.trim()).toBe("Continue setup (3 of 4)");
    expect(stepStatuses()).toEqual(["done", "done", "running", "pending"]);
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
