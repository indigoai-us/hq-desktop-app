// @vitest-environment happy-dom
import { mount, tick } from "svelte";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import ProfilePaneHost from "./ProfilePaneHost.svelte";
import BotSessionPane from "./BotSessionPane.svelte";
import { TRANSCRIPT_VIRTUALIZE_THRESHOLD, type SessionLine } from "./profile-pane-model.js";
import { setBadgeSource } from "../../badges/badge-source.js";

let host: HTMLElement;

afterEach(() => {
  host?.remove();
  setBadgeSource(null);
});

describe("ProfilePaneHost", () => {
  it("hides the Badges section when the person has none", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Maya Chen", company: "Indigo" } });
    await tick();
    expect(host.querySelector('[data-testid="user-profile-pane"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="profile-badges"]')).toBeNull();
  });

  it("shows the newest four badges on a person and on a bot", async () => {
    setBadgeSource(({ kind }) =>
      kind === "bot"
        ? [{ id: "liftoff", tier: 2, earnedAt: "2026-10-05" }]
        : [
            { id: "founding", earnedAt: "2026-03-02" },
            { id: "founder", earnedAt: "2026-03-04" },
            { id: "bughunter", tier: 2, earnedAt: "2026-09-28" },
            { id: "liftoff", tier: 1, earnedAt: "2026-10-06" },
            { id: "poweruser", tier: 3, earnedAt: "2026-09-14" },
          ],
    );
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Maya Chen", company: "Indigo" } });
    await tick();
    const person = host.querySelector('[data-testid="profile-badges"]');
    expect(person?.textContent).toContain("Badges 5");
    expect([...(person?.querySelectorAll("canvas") ?? [])].map((c) => c.getAttribute("data-badge"))).toEqual([
      "liftoff",
      "bughunter",
      "poweruser",
      "founder",
    ]);
    host.remove();

    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "bot", name: "deacon", company: "Indigo" } });
    await tick();
    const bot = host.querySelector('[data-testid="bot-profile-pane"] [data-testid="profile-badges"]');
    expect(bot?.textContent).toContain("Liftoff");
    expect(bot?.textContent).toContain("Silver");
  });

  it("opens a badge's detail from the profile and comes back", async () => {
    setBadgeSource(() => [{ id: "liftoff", tier: 2, earnedAt: "2026-10-06" }]);
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Maya Chen", company: "Indigo" } });
    await tick();
    (host.querySelector('[data-testid="profile-badge"][data-badge-id="liftoff"]') as HTMLButtonElement).click();
    await tick();
    const detail = host.querySelector('[data-testid="badge-detail-pane"]');
    expect(detail?.textContent).toContain("Silver · Earned Oct 6, 2026 by Maya Chen");
    expect([...host.querySelectorAll('[data-testid="badge-level"].current')].map((li) => li.textContent)).toEqual([
      expect.stringContaining("50 deploys"),
    ]);
    (host.querySelector('[data-testid="badge-detail-back"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="badge-detail-pane"]')).toBeNull();
    expect(host.querySelector('[data-testid="user-profile-pane"]')).not.toBeNull();
  });

  it("opens a bot profile from a cached name and reaches the edit sheet", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", company: "Indigo", live: true, owner: "Corey" },
    });
    await tick();
    expect(host.querySelector('[data-testid="bot-profile-pane"]')?.getAttribute("data-phase")).toBe("ready");
    expect(host.querySelector('[data-testid="bot-profile-loading"]')).toBeNull();
    (host.querySelector('[data-testid="bot-profile-edit"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="edit-bot-sheet"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="edit-bot-tab-identity"]')?.getAttribute("aria-selected")).toBe("true");
    (host.querySelector('[data-testid="edit-bot-tab-runtime"]') as HTMLButtonElement).click();
    await tick();
    expect(host.textContent).toContain("heartbeat");
  });

  it("opens a person profile with the loader when the name is empty", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "" } });
    await tick();
    expect(host.querySelector('[data-testid="user-profile-loading"]')).not.toBeNull();
  });

  it("draws the person's mark like the timeline: first + last initials, same mark scaled up", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "Grace Hopper", company: "Indigo" } });
    await tick();
    const mark = host.querySelector('[data-testid="user-profile-pane"] .av .identity');
    expect(mark?.classList.contains("large")).toBe(true);
    expect(mark?.getAttribute("data-kind")).toBe("person");
    expect(mark?.textContent?.trim()).toBe("GH");
  });

  it("person profile wires View in Atlas and Manage access", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const calls: string[] = [];
    mount(ProfilePaneHost, {
      target: host,
      props: {
        kind: "person",
        name: "Maya Chen",
        company: "Indigo",
        onatlas: () => calls.push("atlas"),
        onmanage: () => calls.push("manage"),
      },
    });
    await tick();
    (host.querySelector('[data-testid="user-profile-atlas"]') as HTMLButtonElement).click();
    (host.querySelector('[data-testid="user-profile-manage"]') as HTMLButtonElement).click();
    expect(calls).toEqual(["atlas", "manage"]);
  });

  it("confirms Stop and switches the session to the ended state", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", live: true },
    });
    await tick();
    (host.querySelector('[data-testid="bot-profile-session"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="bot-session-pane"]')?.getAttribute("data-phase")).toBe("live");
    (host.querySelector('[data-testid="bot-session-stop"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="bot-session-confirm"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="bot-session-pane"]')?.getAttribute("data-phase")).toBe("confirm-stop");
    (host.querySelector('[data-testid="bot-session-stop-confirm"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="bot-session-pane"]')?.getAttribute("data-phase")).toBe("ended");
    expect(host.querySelector('[data-testid="bot-session-outcome"]')?.textContent).toContain("Stopped");
    expect(host.querySelector('[data-testid="bot-session-stats"]')?.textContent).toContain("turns");
  });
});

describe("BotSessionPane virtualization", () => {
  it("windows a transcript past 200 rows and keeps tool calls collapsed", async () => {
    const lines: SessionLine[] = Array.from({ length: TRANSCRIPT_VIRTUALIZE_THRESHOLD + 5 }, (_, i) =>
      i % 4 === 0
        ? { id: `t${i}`, kind: "tool" as const, at: "9:40", name: "Bash", detail: `cmd ${i}`, result: "ok" }
        : { id: `s${i}`, kind: "speech" as const, at: "9:40", who: "deacon", text: `line ${i}` },
    );
    host = document.createElement("div");
    host.style.height = "400px";
    document.body.appendChild(host);
    mount(BotSessionPane, {
      target: host,
      props: {
        name: "deacon",
        context: "US-014",
        lines,
        totals: { elapsed: "1:00", tokensIn: "1k", tokensOut: "1k", turns: 3, model: "Opus", outcome: "" },
      },
    });
    await tick();
    const tx = host.querySelector('[data-testid="bot-session-transcript"]');
    expect(tx?.getAttribute("data-windowed")).toBe("true");
    const rendered = host.querySelectorAll('[data-testid="bot-session-tool"], .ln').length;
    expect(rendered).toBeLessThan(lines.length);
    expect(host.querySelector('[data-testid="bot-session-tool-body"]')).toBeNull();
    (host.querySelector('[data-testid="bot-session-tool"]') as HTMLButtonElement | null)?.click();
    await tick();
    expect(host.querySelector('[data-testid="bot-session-tool-body"]')).not.toBeNull();
  });
});

describe("bot profile opened from a DM header (QA-087)", () => {
  it("names the bot from its UID refresh, never the conversation title", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    const agents = {
      getStatus: async () => ({ ok: true, value: { agent: { displayName: "dr-love" } } }),
      listJobs: async () => ({ ok: true, value: [] }),
      getCompanyTelemetry: async () => ({ ok: false, reason: "unavailable", message: "n/a" }),
    };
    mount(ProfilePaneHost, {
      target: host,
      props: {
        kind: "bot",
        name: "",
        company: "Indigo",
        agentUid: "agt_drlove",
        companyUid: "cmp_indigo",
        runtimeKind: "cloud",
        agents: agents as never,
      },
    });
    for (let i = 0; i < 5; i += 1) await tick();
    await new Promise((r) => setTimeout(r, 0));
    await tick();
    const text = host.textContent ?? "";
    expect(text).toContain("dr-love");
    expect(text).toContain("@dr-love");
    expect(text).toContain("Indigo");
    expect(text).not.toContain("Direct message");
    expect(text).not.toContain("direct-message");
  });

  it("the shell's header openers resolve the name by UID, not the header title", () => {
    const src = readFileSync(resolve(process.cwd(), "src/shell/DesktopApp.svelte"), "utf8");
    for (const fn of ["function openAgentProfileFromHeader", "function openAgentFromHeader"]) {
      const body = src.slice(src.indexOf(fn), src.indexOf(fn) + 700);
      expect(body).toContain("displayName: headerAgentName(uid)");
      expect(body).not.toContain("displayName: headerTitle");
    }
  });
});
