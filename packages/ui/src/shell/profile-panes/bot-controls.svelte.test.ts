// @vitest-environment happy-dom
/**
 * Bot controls live in the profile sidepane. The access and capabilities
 * checks are ported from the retired six-step sheet (NewAgentStepper.test.ts:
 * read/write grants only, the shared folder and skill pickers) onto the
 * pane's Edit sheet, where those controls now live.
 */
import { mount, tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProfilePaneHost from "./ProfilePaneHost.svelte";
import EditBotSheet from "./EditBotSheet.svelte";
import { emptyDraft } from "../../agents/agent-stepper-model.js";

let host: HTMLElement;

afterEach(() => {
  host?.remove();
});

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return host.querySelector<T>(sel);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

function agentsApi() {
  return {
    listJobs: vi.fn(async () => ({ ok: true as const, value: { jobs: [{ jobId: "j1", prompt: "Morning brief", schedule: "0 9 * * *", active: true }] } })),
    getCompanyTelemetry: vi.fn(async () => ({
      ok: true as const,
      value: { perMember: [{ personUid: "agt_01DEACON", tokens: { input: 1200, output: 300 }, sessions: 4 }] },
    })),
    getStatus: vi.fn(async () => ({ ok: true as const, value: {} })),
    stop: vi.fn(async () => ({ ok: true as const, value: {} })),
    start: vi.fn(async () => ({ ok: true as const, value: {} })),
  };
}

describe("bot sidepane controls", () => {
  it("shows the UID with Copy, the runtime chip, scheduled jobs and 30-day usage", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const agents = agentsApi();
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", live: true, agentUid: "agt_01DEACON", runtimeKind: "cloud", companyUid: "cmp_indigo", agents: agents as never },
    });
    await tick();
    // First frame: cached profile plus a usage skeleton, before any reply.
    expect(q('[data-testid="bot-profile-usage"]')?.getAttribute("data-state")).toBe("loading");
    expect(q('[data-testid="bot-profile-uid"]')?.textContent).toContain("agt_01DEACON");
    expect(q('[data-testid="bot-profile-runtime-chip"]')?.textContent).toBe("Cloud");
    await settle();
    expect(agents.listJobs).toHaveBeenCalledWith("agt_01DEACON");
    expect(q('[data-testid="bot-profile-usage"]')?.getAttribute("data-state")).toBe("ready");
    expect(host.textContent).toContain("Scheduled jobs");
    q<HTMLButtonElement>('[data-testid="bot-profile-copy-uid"]')!.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("agt_01DEACON");
    expect(q('[data-testid="bot-profile-copy-uid"]')?.textContent).toBe("Copied");
  });

  it("pauses and resumes through the agents API, and Stop opens the session stop confirm", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const agents = agentsApi();
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", live: true, agentUid: "agt_01DEACON", runtimeKind: "local", agents: agents as never },
    });
    await settle();
    const pause = () => q<HTMLButtonElement>('[data-testid="bot-profile-pause"]')!;
    expect(pause().textContent).toBe("Pause");
    pause().click();
    await tick();
    expect(pause().textContent).toBe("Resume");
    await settle();
    expect(agents.stop).toHaveBeenCalledWith("agt_01DEACON");
    pause().click();
    await settle();
    expect(agents.start).toHaveBeenCalledWith("agt_01DEACON");
    expect(pause().textContent).toBe("Pause");
    q<HTMLButtonElement>('[data-testid="bot-profile-stop"]')!.click();
    await tick();
    expect(q('[data-testid="bot-session-pane"]')?.getAttribute("data-phase")).toBe("confirm-stop");
  });

  it("rolls Pause back and says so when the server refuses", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const agents = { ...agentsApi(), stop: vi.fn(async () => ({ ok: false as const, reason: "error" as const, message: "nope" })) };
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", agentUid: "agt_01DEACON", agents: agents as never },
    });
    await settle();
    q<HTMLButtonElement>('[data-testid="bot-profile-pause"]')!.click();
    await settle();
    expect(q('[data-testid="bot-profile-pause"]')?.textContent).toBe("Pause");
    expect(q('[data-testid="bot-profile-action-error"]')?.textContent).toContain("Could not pause");
  });

  it("section Edit links open the edit sheet on that tab", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "bot", name: "deacon", company: "Indigo" } });
    await tick();
    q<HTMLButtonElement>('[data-testid="bot-profile-edit-runtime"]')!.click();
    await tick();
    expect(q('[data-testid="edit-bot-tab-runtime"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("edits vault grants as read or write only, through the folder picker", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(EditBotSheet, {
      target: host,
      props: { name: "ledger", initialTab: "access", folders: [{ path: "companies/indigo/knowledge/", note: "read" }] },
    });
    await tick();
    q<HTMLButtonElement>('[data-testid="edit-bot-add-path"]')!.click();
    await tick();
    expect(q('[data-testid="folder-picker"]')).not.toBeNull();
    q<HTMLButtonElement>('[data-testid="folder-picker-row"]')!.click();
    await tick();
    q<HTMLButtonElement>('[data-testid="folder-picker-choose"]')!.click();
    await tick();
    const write = q<HTMLButtonElement>('[data-testid="edit-bot-grant-write"]')!;
    write.click();
    await tick();
    expect(q('[data-testid="edit-bot-grant-write"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-testid="edit-bot-grant-read"]')?.getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).not.toMatch(/\badmin\b/i);
  });

  it("picks skills through the shared skill picker", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const onsave = vi.fn();
    mount(EditBotSheet, {
      target: host,
      props: {
        name: "ledger",
        initialTab: "capabilities",
        draft: emptyDraft({ name: "ledger", skills: [{ id: "standup-brief", title: "Standup brief", detail: "Daily", selected: false }] }),
        onsave,
      },
    });
    await tick();
    q<HTMLButtonElement>('[data-testid="edit-bot-open-skills"]')!.click();
    await tick();
    expect(q('[data-testid="skill-picker"]')).not.toBeNull();
    q<HTMLButtonElement>('[data-testid="skill-picker-standup-brief"]')!.click();
    await tick();
    q<HTMLButtonElement>(".sp-done")!.click();
    await tick();
    q<HTMLButtonElement>('[data-testid="edit-bot-save"]')!.click();
    expect(onsave).toHaveBeenCalledOnce();
    expect(onsave.mock.calls[0]![0].skills[0].selected).toBe(true);
  });

  // QA-063: the Companies section came from the viewing company, so dr-love
  // read "Companies 1: A" from A and "Companies 1: B" from B.
  it("shows the bot's real memberships from either company's entry point", async () => {
    const status = {
      agentUid: "agt_01DRLOVE",
      memberships: [
        { companyUid: "cmp_a", companyName: "Acme", role: "member", status: "active" },
        { companyUid: "cmp_b", companyName: "Bolt", role: "admin", status: "active" },
        { companyUid: "cmp_c", companyName: "Gone", role: "member", status: "revoked" },
      ],
    };
    for (const viewing of [{ company: "Acme", companyUid: "cmp_a" }, { company: "Bolt", companyUid: "cmp_b" }]) {
      host = document.createElement("div");
      document.body.appendChild(host);
      const agents = { ...agentsApi(), getStatus: vi.fn(async () => ({ ok: true as const, value: status })) };
      mount(ProfilePaneHost, {
        target: host,
        props: { kind: "bot", name: "dr-love", agentUid: "agt_01DRLOVE", runtimeKind: "cloud", ...viewing, agents: agents as never },
      });
      await tick();
      // Cached first frame only knows this company: no count is claimed.
      expect(q('[data-testid="bot-profile-companies-label"]')?.textContent).toContain("In this company");
      expect(host.querySelectorAll('[data-testid="bot-profile-company"]').length).toBe(1);
      await settle();
      expect(agents.getStatus).toHaveBeenCalledWith("agt_01DRLOVE");
      const label = q('[data-testid="bot-profile-companies-label"]')?.textContent ?? "";
      expect(label).toContain("Companies");
      expect(label).toContain("2");
      const rows = [...host.querySelectorAll('[data-testid="bot-profile-company"]')].map((el) => el.textContent?.trim());
      expect(rows).toEqual(["ACAcmeMember", "BOBoltAdmin"]);
      host.remove();
    }
  });

  it("keeps the in-this-company label when the status has no membership list", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "dr-love", agentUid: "agt_01DRLOVE", company: "Acme", companyUid: "cmp_a", agents: agentsApi() as never },
    });
    await settle();
    expect(q('[data-testid="bot-profile-companies-label"]')?.textContent).toContain("In this company");
    expect(q('[data-testid="bot-profile-companies-label"]')?.querySelector(".count")).toBeNull();
  });
});
