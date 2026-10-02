// @vitest-environment happy-dom
import { mount, tick } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import ProfilePaneHost from "./ProfilePaneHost.svelte";
import BotSessionPane from "./BotSessionPane.svelte";
import { TRANSCRIPT_VIRTUALIZE_THRESHOLD, type SessionLine } from "./profile-pane-model.js";

let host: HTMLElement;

afterEach(() => {
  host?.remove();
});

describe("ProfilePaneHost", () => {
  it("opens a bot profile from a cached name and reaches the edit sheet", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", company: "Indigo", live: true, owner: "Corey" },
    });
    await tick();
    expect(host.querySelector('[data-testid="bot-profile-pane"]')?.getAttribute("data-phase")).toBe("ready");
    expect(host.querySelector('[data-testid="bot-profile-shimmer"]')).toBeNull();
    (host.querySelector('[data-testid="bot-profile-edit"]') as HTMLButtonElement).click();
    await tick();
    expect(host.querySelector('[data-testid="edit-bot-sheet"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="edit-bot-tab-identity"]')?.getAttribute("aria-selected")).toBe("true");
    (host.querySelector('[data-testid="edit-bot-tab-runtime"]') as HTMLButtonElement).click();
    await tick();
    expect(host.textContent).toContain("heartbeat");
  });

  it("opens a person profile with a shimmer when the name is empty", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    mount(ProfilePaneHost, { target: host, props: { kind: "person", name: "" } });
    await tick();
    expect(host.querySelector('[data-testid="user-profile-shimmer"]')).not.toBeNull();
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
