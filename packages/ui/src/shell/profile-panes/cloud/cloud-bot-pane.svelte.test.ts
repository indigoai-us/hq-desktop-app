// @vitest-environment happy-dom
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentControlApi } from "@hq/platform";
import ProfilePaneHost from "../ProfilePaneHost.svelte";
import CloudBotPane from "./CloudBotPane.svelte";
import ChannelsTab from "./ChannelsTab.svelte";
import { CLOUD_BOT_TABS, forgetRememberedTabs } from "./cloud-bot-tabs.js";

const UID = "agt_01NOVA";

const CONTROL = {
  agent: { uid: UID, displayName: "Nova", title: "Research analyst", avatarUrl: null, online: true, lastSeenAt: null },
  channels: [
    { kind: "hq", enabled: true, status: "connected", detail: null },
    { kind: "slack", enabled: true, status: "connected", detail: "#ops" },
    { kind: "telegram", enabled: false, status: "not_connected", detail: null },
    { kind: "email", enabled: false, status: "connected", detail: null },
  ],
  routines: [
    { id: "r1", name: "Morning brief", schedule: "0 9 * * 1-5", timezone: "UTC", prompt: "Summarize.", enabled: true, lastRunAt: null, nextRunAt: null, lastStatus: "ok" },
  ],
  persona: { displayName: "Nova", title: "Research analyst", description: "Reads the news.", instructions: "Be brief.\nCite sources.", instructionsPath: "SOUL.md", updatedAt: null },
  brain: {
    model: "claude-opus-5-5",
    provider: "anthropic",
    availableModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
    memory: [{ id: "m1", title: "Prefers tea", preview: "Tea, not coffee", updatedAt: null }],
    knowledge: [{ path: "faq.md", size: 2048, updatedAt: null }],
  },
  source: "live",
  fetchedAt: "2026-10-13T12:00:00Z",
};

type Res = { ok: true; value: unknown } | { ok: false; reason: "error"; code?: string; message?: string; status?: number };
const ok = (value: unknown): Res => ({ ok: true, value });
const refused = (code: string, message: string, status = 409): Res => ({ ok: false, reason: "error", code, message, status });

function controlApi(over: Partial<Record<keyof AgentControlApi, (...a: never[]) => Promise<Res>>> = {}) {
  const view = structuredClone(CONTROL);
  const api = {
    getControl: vi.fn(async () => ok(structuredClone(view))),
    listChannels: vi.fn(async () => ok(view.channels)),
    updateChannel: vi.fn(async (_u: string, kind: string, patch: { enabled?: boolean }) => {
      const ch = view.channels.find((c) => c.kind === kind)!;
      ch.enabled = patch.enabled ?? ch.enabled;
      return ok(ch);
    }),
    listRoutines: vi.fn(async () => ok({ routines: view.routines })),
    createRoutine: vi.fn(async (_u: string, input: Record<string, unknown>) => {
      const r = { id: "r2", lastRunAt: null, nextRunAt: null, lastStatus: null, timezone: null, enabled: true, ...input } as unknown as (typeof view.routines)[number];
      view.routines.push(r);
      return ok(r);
    }),
    updateRoutine: vi.fn(async (_u: string, id: string, patch: Record<string, unknown>) => {
      const r = view.routines.find((x) => x.id === id)!;
      Object.assign(r, patch);
      return ok(r);
    }),
    deleteRoutine: vi.fn(async (_u: string, id: string) => {
      view.routines = view.routines.filter((x) => x.id !== id);
      return ok(null);
    }),
    runRoutine: vi.fn(async () => ok({ started: true })),
    getPersona: vi.fn(async () => ok(view.persona)),
    updatePersona: vi.fn(async (_u: string, patch: Record<string, string>) => {
      Object.assign(view.persona, patch);
      return ok({ persona: view.persona });
    }),
    getBrain: vi.fn(async () => ok(view.brain)),
    setModel: vi.fn(async (_u: string, model: string) => {
      view.brain.model = model;
      return ok({ model });
    }),
    createMemory: vi.fn(async (_u: string, input: { title?: string; content: string }) => {
      view.brain.memory.push({ id: "m2", title: input.title ?? "New", preview: input.content, updatedAt: null });
      return ok({ id: "m2" });
    }),
    getMemory: vi.fn(async (_u: string, id: string) => ok({ id, title: "Prefers tea", content: "# Tea\n\nNot **coffee**." })),
    updateMemory: vi.fn(async () => ok({ ok: true })),
    deleteMemory: vi.fn(async (_u: string, id: string) => {
      view.brain.memory = view.brain.memory.filter((m) => m.id !== id);
      return ok(null);
    }),
    getKnowledge: vi.fn(async (_u: string, path: string) => ok({ path, content: "FAQ body" })),
    putKnowledge: vi.fn(async (_u: string, path: string) => {
      if (!view.brain.knowledge.some((k) => k.path === path)) view.brain.knowledge.push({ path, size: 10, updatedAt: null });
      return ok({ path });
    }),
    deleteKnowledge: vi.fn(async () => ok(null)),
    ...over,
  };
  return { api: api as unknown as AgentControlApi & typeof api, view };
}

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

beforeEach(() => {
  forgetRememberedTabs();
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
  document.body.innerHTML = "";
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await tick();
    await Promise.resolve();
  }
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const click = (sel: string) => {
  const el = q<HTMLButtonElement>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  el.click();
};
function type(sel: string, value: string): void {
  const el = q<HTMLInputElement | HTMLTextAreaElement>(sel)!;
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

async function mountPane(api: AgentControlApi | null, props: Record<string, unknown> = {}) {
  component = mount(CloudBotPane, { target: host, props: { uid: UID, name: "nova", live: true, control: api, ...props } });
  await settle();
}

async function openTab(id: string): Promise<void> {
  click(`[data-testid="cloud-bot-tab-${id}"]`);
  await settle();
}

describe("cloud bot pane: host routing and removed controls", () => {
  it("renders the tabbed pane for cloud bots, with no Pause, Open session, Stop or 30-day usage", async () => {
    const { api } = controlApi();
    const agents = {
      listJobs: vi.fn(async () => ok({ jobs: [] })),
      getCompanyTelemetry: vi.fn(async () => ok({ perMember: [] })),
      getStatus: vi.fn(async () => ok({})),
      stop: vi.fn(),
      start: vi.fn(),
    };
    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "nova", live: true, agentUid: UID, runtimeKind: "cloud", companyUid: "cmp_indigo", agents: agents as never, control: api },
    });
    await settle();
    expect(q('[data-testid="cloud-bot-pane"]')).not.toBeNull();
    for (const gone of ["bot-profile-pause", "bot-profile-session", "bot-profile-stop", "bot-profile-usage", "bot-profile-edit"]) {
      expect(q(`[data-testid="${gone}"]`), gone).toBeNull();
    }
    expect(host.textContent).not.toMatch(/30d usage|Pause|Resume|Open session|\bStop\b/);
    expect(agents.getCompanyTelemetry).not.toHaveBeenCalled();
    expect(agents.listJobs).not.toHaveBeenCalled();
    expect(api.getControl).toHaveBeenCalledWith(UID);
  });

  it("names a cloud bot from its UID refresh, never the conversation title (QA-087)", async () => {
    let answer: (v: Res) => void = () => {};
    const { api } = controlApi({ getControl: () => new Promise<Res>((r) => (answer = r)) });
    const agents = { getStatus: vi.fn(async () => ok({ agent: { displayName: "dr-love" } })) };
    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "", company: "Indigo", agentUid: "agt_drlove", companyUid: "cmp_indigo", runtimeKind: "cloud", agents: agents as never, control: api },
    });
    await settle();
    expect(agents.getStatus).toHaveBeenCalledWith("agt_drlove");
    expect(q('[data-testid="cloud-bot-name"]')?.textContent).toBe("dr-love");
    expect(host.textContent).not.toContain("Direct message");
    answer(ok({ ...CONTROL, agent: { ...CONTROL.agent, uid: "agt_drlove", displayName: "Dr Love" } }));
    await settle();
    expect(q('[data-testid="cloud-bot-name"]')?.textContent).toBe("Dr Love");
  });

  it("keeps the old pane for local bots", async () => {
    const agents = { listJobs: vi.fn(async () => ok({ jobs: [] })), getCompanyTelemetry: vi.fn(async () => ok({ perMember: [] })), getStatus: vi.fn(async () => ok({})) };
    component = mount(ProfilePaneHost, {
      target: host,
      props: { kind: "bot", name: "deacon", agentUid: "agt_local", runtimeKind: "local", agents: agents as never, control: controlApi().api },
    });
    await settle();
    expect(q('[data-testid="cloud-bot-pane"]')).toBeNull();
    expect(q('[data-testid="bot-profile-pane"]')).not.toBeNull();
  });
});

describe("cloud bot pane: header and tabs", () => {
  it("shows avatar, name, title, Cloud chip and online state, then the four tabs from the one list", async () => {
    const { api } = controlApi();
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-avatar"]')).not.toBeNull();
    expect(q('[data-testid="cloud-bot-name"]')?.textContent).toBe("Nova");
    expect(q('[data-testid="cloud-bot-title"]')?.textContent).toBe("Research analyst");
    expect(q('[data-testid="bot-profile-runtime-chip"]')?.textContent).toBe("Cloud");
    expect(q('[data-testid="cloud-bot-presence"]')?.textContent?.trim()).toBe("Online");
    expect(qa('[role="tab"]').map((t) => t.textContent)).toEqual(["Channels", "Routines", "Persona", "Brain"]);
    expect(CLOUD_BOT_TABS.map((t) => t.id)).toEqual(["channels", "routines", "persona", "brain"]);
    expect(host.textContent).not.toContain("Apps");
  });

  it("keeps Message, which opens the bot's DM", async () => {
    const { api } = controlApi();
    const onmessage = vi.fn();
    await mountPane(api, { onmessage });
    click('[data-testid="bot-profile-message"]');
    expect(onmessage).toHaveBeenCalledOnce();
  });

  it("adds a tab with one entry in the tab list", async () => {
    const { api } = controlApi();
    await mountPane(api, { tabs: [...CLOUD_BOT_TABS, { id: "apps", label: "Apps", component: ChannelsTab }] });
    expect(qa('[role="tab"]').map((t) => t.textContent)).toEqual(["Channels", "Routines", "Persona", "Brain", "Apps"]);
    await openTab("apps");
    expect(q('[data-testid="cloud-bot-panel"]')?.getAttribute("data-tab")).toBe("apps");
  });

  it("moves between tabs with the arrow keys and remembers the last tab per bot", async () => {
    const { api } = controlApi();
    await mountPane(api);
    const first = q<HTMLButtonElement>('[data-testid="cloud-bot-tab-channels"]')!;
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await settle();
    expect(q('[data-testid="cloud-bot-tab-routines"]')?.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("cloud-bot-tab-routines");
    q<HTMLButtonElement>('[data-testid="cloud-bot-tab-routines"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await settle();
    expect(q('[data-testid="cloud-bot-panel"]')?.getAttribute("data-tab")).toBe("brain");
    unmount(component!);
    component = null;
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-panel"]')?.getAttribute("data-tab")).toBe("brain");
    unmount(component!);
    component = null;
    await mountPane(api, { uid: "agt_other" });
    expect(q('[data-testid="cloud-bot-panel"]')?.getAttribute("data-tab")).toBe("channels");
  });

  it("shows the loader until the box answers", async () => {
    let answer: (v: Res) => void = () => {};
    const { api } = controlApi({ getControl: () => new Promise<Res>((r) => (answer = r)) });
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-loading"]')).not.toBeNull();
    expect(q('[data-testid="cloud-bot-pane"]')?.getAttribute("data-state")).toBe("loading");
    answer(ok(CONTROL));
    await settle();
    expect(q('[data-testid="cloud-bot-loading"]')).toBeNull();
    expect(qa('[data-testid="cloud-channel-row"]')).toHaveLength(4);
  });

  it("shows the server's message when the read fails, and Try again reads again", async () => {
    const getControl = vi.fn(async () => refused("FORBIDDEN", "Only owners can see this bot's controls.", 403));
    const { api } = controlApi({ getControl });
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-error"]')?.textContent).toContain("Only owners can see this bot's controls.");
    getControl.mockImplementationOnce(async () => ok(CONTROL));
    click('[data-testid="cloud-bot-retry"]');
    await settle();
    expect(getControl).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="cloud-bot-error"]')).toBeNull();
  });

  it("says so when the box is offline and blocks writes", async () => {
    const offline = { ...structuredClone(CONTROL), agent: { ...CONTROL.agent, online: false, lastSeenAt: new Date(Date.now() - 2 * 3600_000).toISOString() } };
    const { api } = controlApi({ getControl: async () => ok(offline) });
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-offline"]')?.textContent).toBe("This bot is offline. Changes will fail until it's back.");
    expect(q('[data-testid="cloud-bot-presence"]')?.textContent?.trim()).toBe("Offline · last seen 2h ago");
    expect(qa('[data-testid="cloud-channel-toggle"]').every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    await openTab("routines");
    expect(q<HTMLButtonElement>('[data-testid="cloud-routine-new"]')?.disabled).toBe(true);
  });

  it("notes a snapshot read", async () => {
    const { api } = controlApi({ getControl: async () => ok({ ...CONTROL, source: "snapshot" }) });
    await mountPane(api);
    expect(q('[data-testid="cloud-bot-snapshot"]')).not.toBeNull();
  });
});

describe("Channels tab", () => {
  it("toggles a channel and shows the box's read-back", async () => {
    const { api } = controlApi();
    await mountPane(api);
    const slack = q('[data-testid="cloud-channel-row"][data-kind="slack"]')!;
    expect(slack.querySelector('[data-testid="cloud-channel-state"]')?.textContent).toBe("#ops");
    (slack.querySelector('[data-testid="cloud-channel-toggle"]') as HTMLButtonElement).click();
    await settle();
    expect(api.updateChannel).toHaveBeenCalledWith(UID, "slack", { enabled: false });
    expect(api.listChannels).toHaveBeenCalled();
    const after = q('[data-testid="cloud-channel-row"][data-kind="slack"]')!;
    expect(after.querySelector('[data-testid="cloud-channel-toggle"]')?.getAttribute("aria-checked")).toBe("false");
    expect(after.querySelector('[data-testid="cloud-channel-state"]')?.textContent).toBe("Off");
  });

  it("shows the server message on a refusal and turns on the offline banner for an offline box", async () => {
    const { api } = controlApi({ updateChannel: async () => refused("BOX_OFFLINE", "The bot's computer is not answering.") });
    await mountPane(api);
    (q('[data-testid="cloud-channel-row"][data-kind="hq"] [data-testid="cloud-channel-toggle"]') as HTMLButtonElement).click();
    await settle();
    expect(q('[data-testid="cloud-channels-error"]')?.textContent).toBe("The bot's computer is not answering.");
    expect(q('[data-testid="cloud-bot-offline"]')).not.toBeNull();
    expect(api.listChannels).not.toHaveBeenCalled();
  });

  it("reports a read-back that did not keep the change", async () => {
    const { api, view } = controlApi();
    (api.updateChannel as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => ok(view.channels[0]));
    await mountPane(api);
    (q('[data-testid="cloud-channel-row"][data-kind="hq"] [data-testid="cloud-channel-toggle"]') as HTMLButtonElement).click();
    await settle();
    expect(q('[data-testid="cloud-channels-error"]')?.textContent).toContain("did not confirm");
  });

  it("Connect opens a pop-up that hands Slack to the app's existing setup", async () => {
    const offSlack = { ...structuredClone(CONTROL), channels: CONTROL.channels.map((c) => (c.kind === "slack" ? { ...c, status: "not_connected", enabled: false } : c)) };
    const { api } = controlApi({ getControl: async () => ok(offSlack) });
    const onconnect = vi.fn();
    await mountPane(api, { onconnect });
    click('[data-testid="cloud-channel-row"][data-kind="slack"] [data-testid="cloud-channel-connect"]');
    await settle();
    expect(q('[data-testid="cloud-channel-dialog"]')).not.toBeNull();
    click('[data-testid="cloud-channel-start"]');
    await settle();
    expect(onconnect).toHaveBeenCalledWith("slack");
    expect(q('[data-testid="cloud-channel-dialog"]')).toBeNull();
  });
});

describe("Routines tab", () => {
  it("lists routines with the schedule in plain words", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    expect(q('[data-testid="cloud-routine-schedule"]')?.textContent).toBe("Weekdays at 9:00");
  });

  it("shows an empty state with one action", async () => {
    const { api } = controlApi({ getControl: async () => ok({ ...CONTROL, routines: [] }) });
    await mountPane(api);
    await openTab("routines");
    expect(q('[data-testid="cloud-routines-empty"]')).not.toBeNull();
    expect(qa('[data-testid="cloud-routine-new"]')).toHaveLength(1);
  });

  it("edits a routine in the pop-up and saves through the API", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-open"]');
    await settle();
    expect(q('[data-testid="cloud-routine-dialog"]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-testid="cloud-routine-save"]')?.disabled).toBe(true);
    type('[data-testid="cloud-routine-name"]', "Evening brief");
    click('[data-testid="cloud-routine-preset-daily"]');
    await settle();
    expect(q('[data-testid="cloud-routine-words"]')?.textContent).toBe("Daily at 9:00");
    click('[data-testid="cloud-routine-save"]');
    await settle();
    expect(api.updateRoutine).toHaveBeenCalledWith(UID, "r1", expect.objectContaining({ name: "Evening brief", schedule: "0 9 * * *" }));
    expect(q('[data-testid="cloud-routine-dialog"]')).toBeNull();
    expect(q('[data-testid="cloud-routine-row"]')?.textContent).toContain("Evening brief");
  });

  it("creates a routine from New routine", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-new"]');
    await settle();
    type('[data-testid="cloud-routine-name"]', "Standup");
    type('[data-testid="cloud-routine-prompt"]', "Post the standup.");
    click('[data-testid="cloud-routine-save"]');
    await settle();
    expect(api.createRoutine).toHaveBeenCalledWith(UID, expect.objectContaining({ name: "Standup", prompt: "Post the standup.", enabled: true }));
    expect(qa('[data-testid="cloud-routine-row"]')).toHaveLength(2);
  });

  it("keeps the pop-up open with the server message when a save is refused", async () => {
    const { api } = controlApi({ updateRoutine: async () => refused("READBACK_MISMATCH", "The box did not keep the change.", 502) });
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-open"]');
    await settle();
    type('[data-testid="cloud-routine-name"]', "x");
    click('[data-testid="cloud-routine-save"]');
    await settle();
    expect(q('[data-testid="cloud-routine-error"]')?.textContent).toBe("The box did not keep the change.");
    expect(q('[data-testid="cloud-routine-dialog"]')).not.toBeNull();
  });

  it("runs now and deletes after a confirm", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-open"]');
    await settle();
    click('[data-testid="cloud-routine-run"]');
    await settle();
    expect(api.runRoutine).toHaveBeenCalledWith(UID, "r1");
    expect(q('[data-testid="cloud-routine-note"]')).not.toBeNull();
    click('[data-testid="cloud-routine-delete"]');
    await settle();
    expect(api.deleteRoutine).not.toHaveBeenCalled();
    click('[data-testid="confirm-dialog-ok"]');
    await settle();
    expect(api.deleteRoutine).toHaveBeenCalledWith(UID, "r1");
    expect(q('[data-testid="cloud-routines-empty"]')).not.toBeNull();
  });

  it("toggles a routine and asks before discarding unsaved edits", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-toggle"]');
    await settle();
    expect(api.updateRoutine).toHaveBeenCalledWith(UID, "r1", { enabled: false });
    expect(q('[data-testid="cloud-routine-toggle"]')?.getAttribute("aria-checked")).toBe("false");
    click('[data-testid="cloud-routine-open"]');
    await settle();
    type('[data-testid="cloud-routine-name"]', "changed");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(q('[data-testid="cloud-routine-dialog"]')).not.toBeNull();
    expect(q('[data-testid="confirm-dialog"]')?.textContent).toContain("Discard changes?");
    click('[data-testid="confirm-dialog-ok"]');
    await settle();
    expect(q('[data-testid="cloud-routine-dialog"]')).toBeNull();
  });

  it("closes a clean pop-up on Esc without asking", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("routines");
    click('[data-testid="cloud-routine-open"]');
    await settle();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await settle();
    expect(q('[data-testid="cloud-routine-dialog"]')).toBeNull();
    expect(q('[data-testid="confirm-dialog"]')).toBeNull();
  });
});

describe("Persona tab", () => {
  it("shows the profile read-only with a clamped instructions preview", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("persona");
    expect(q('[data-testid="cloud-persona-title"]')?.textContent).toBe("Research analyst");
    expect(q('[data-testid="cloud-persona-preview"]')?.textContent).toContain("Cite sources.");
  });

  it("saves only the changed fields and shows the read-back", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("persona");
    click('[data-testid="cloud-persona-edit"]');
    await settle();
    type('[data-testid="cloud-persona-instructions-input"]', "Be very brief.");
    type('[data-testid="cloud-persona-title-input"]', "Lead analyst");
    click('[data-testid="cloud-persona-save"]');
    await settle();
    expect(api.updatePersona).toHaveBeenCalledWith(UID, { title: "Lead analyst", instructions: "Be very brief." });
    expect(q('[data-testid="cloud-persona-dialog"]')).toBeNull();
    expect(q('[data-testid="cloud-persona-preview"]')?.textContent).toBe("Be very brief.");
    expect(q('[data-testid="cloud-bot-title"]')?.textContent).toBe("Lead analyst");
    expect(q('[data-testid="cloud-persona-saved"]')).not.toBeNull();
  });

  it("re-reads the persona when the write answer has none", async () => {
    const { api } = controlApi({ updatePersona: async () => ok({ ok: true }) });
    await mountPane(api);
    await openTab("persona");
    click('[data-testid="cloud-persona-edit"]');
    await settle();
    type('[data-testid="cloud-persona-description-input"]', "New description");
    click('[data-testid="cloud-persona-save"]');
    await settle();
    expect(api.getPersona).toHaveBeenCalledWith(UID);
  });

  it("shows the server's error inside the pop-up", async () => {
    const { api } = controlApi({ updatePersona: async () => refused("INSTRUCTIONS_TOO_LARGE", "Instructions are over 64 KB.", 413) });
    await mountPane(api);
    await openTab("persona");
    click('[data-testid="cloud-persona-edit"]');
    await settle();
    type('[data-testid="cloud-persona-instructions-input"]', "x".repeat(10));
    click('[data-testid="cloud-persona-save"]');
    await settle();
    expect(q('[data-testid="cloud-persona-error"]')?.textContent).toBe("Instructions are over 64 KB.");
  });

  it("shows an empty state when there are no instructions", async () => {
    const { api } = controlApi({ getControl: async () => ok({ ...CONTROL, persona: { ...CONTROL.persona, instructions: "" } }) });
    await mountPane(api);
    await openTab("persona");
    expect(q('[data-testid="cloud-persona-empty"]')).not.toBeNull();
  });
});

describe("Brain tab", () => {
  it("changes the model through the picker and reads it back", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("brain");
    expect(q('[data-testid="cloud-brain-model-value"]')?.textContent).toBe("claude-opus-5-5");
    click('[data-testid="cloud-brain-model-change"]');
    await settle();
    const radios = qa('[data-testid="cloud-model-option"] input') as HTMLInputElement[];
    radios[1]!.click();
    flushSync();
    click('[data-testid="cloud-model-save"]');
    await settle();
    expect(api.setModel).toHaveBeenCalledWith(UID, "claude-sonnet-5-5");
    expect(api.getBrain).toHaveBeenCalled();
    expect(q('[data-testid="cloud-model-dialog"]')).toBeNull();
    expect(q('[data-testid="cloud-brain-model-value"]')?.textContent).toBe("claude-sonnet-5-5");
  });

  it("opens a memory as rendered Markdown, edits and saves it", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("brain");
    click('[data-testid="cloud-brain-memory-row"] button');
    await settle();
    expect(api.getMemory).toHaveBeenCalledWith(UID, "m1");
    expect(q('[data-testid="cloud-brain-doc"] strong')?.textContent).toBe("coffee");
    click('[data-testid="cloud-brain-edit"]');
    await settle();
    type('[data-testid="cloud-brain-editor"]', "Tea only.");
    click('[data-testid="cloud-brain-save"]');
    await settle();
    expect(api.updateMemory).toHaveBeenCalledWith(UID, "m1", "Tea only.");
    expect(api.getBrain).toHaveBeenCalled();
  });

  it("deletes a knowledge file after a confirm", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("brain");
    click('[data-testid="cloud-brain-knowledge-row"] button');
    await settle();
    expect(q('[data-testid="cloud-brain-doc"]')?.textContent).toContain("FAQ body");
    click('[data-testid="cloud-brain-delete"]');
    await settle();
    click('[data-testid="confirm-dialog-ok"]');
    await settle();
    expect(api.deleteKnowledge).toHaveBeenCalledWith(UID, "faq.md");
    expect(q('[data-testid="cloud-brain-dialog"]')).toBeNull();
  });

  it("adds a knowledge file only at a safe relative path", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("brain");
    click('[data-testid="cloud-brain-knowledge-add"]');
    await settle();
    type('[data-testid="cloud-brain-path-input"]', "../escape.md");
    type('[data-testid="cloud-brain-editor"]', "hello");
    expect(q<HTMLButtonElement>('[data-testid="cloud-brain-save"]')?.disabled).toBe(true);
    type('[data-testid="cloud-brain-path-input"]', "notes/pricing.md");
    expect(q<HTMLButtonElement>('[data-testid="cloud-brain-save"]')?.disabled).toBe(false);
    click('[data-testid="cloud-brain-save"]');
    await settle();
    expect(api.putKnowledge).toHaveBeenCalledWith(UID, "notes/pricing.md", "hello");
    expect(qa('[data-testid="cloud-brain-knowledge-row"]').map((r) => r.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("notes/pricing.md")]),
    );
  });

  it("adds a memory", async () => {
    const { api } = controlApi();
    await mountPane(api);
    await openTab("brain");
    click('[data-testid="cloud-brain-memory-add"]');
    await settle();
    type('[data-testid="cloud-brain-title-input"]', "Timezone");
    type('[data-testid="cloud-brain-editor"]', "Works in Denver.");
    click('[data-testid="cloud-brain-save"]');
    await settle();
    expect(api.createMemory).toHaveBeenCalledWith(UID, { title: "Timezone", content: "Works in Denver." });
    expect(qa('[data-testid="cloud-brain-memory-row"]')).toHaveLength(2);
  });

  it("shows empty states for memory and knowledge", async () => {
    const { api } = controlApi({ getControl: async () => ok({ ...CONTROL, brain: { ...CONTROL.brain, memory: [], knowledge: [] } }) });
    await mountPane(api);
    await openTab("brain");
    expect(q('[data-testid="cloud-brain-memory-empty"]')).not.toBeNull();
    expect(q('[data-testid="cloud-brain-knowledge-empty"]')).not.toBeNull();
  });

  it("shows the server's message when a memory cannot be read", async () => {
    const { api } = controlApi({ getMemory: async () => refused("MEMORY_NOT_FOUND", "That memory is gone.", 404) });
    await mountPane(api);
    await openTab("brain");
    click('[data-testid="cloud-brain-memory-row"] button');
    await settle();
    expect(q('[data-testid="cloud-brain-error"]')?.textContent).toBe("That memory is gone.");
  });
});
