// @vitest-environment happy-dom

/**
 * Slices 2 and 5 in the takeover: "Your team", Note taker and Project
 * management. One decision per screen, every async button pending on the
 * same press and deaf to repeats, a failure line with Retry and Continue in
 * chat, and nothing of it on a host without the team or apps hosts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import FirstRunTakeover from "./FirstRunTakeover.svelte";
import type { FirstRunAppsHost, FirstRunSettled, FirstRunTeamHost } from "./first-run-hosts.js";
import type { AppCatalogResult, AppConnectResult, FirstRunApp } from "./app-step.js";
import type { FirstRunTeamOptions, TeamActionResult } from "./team-step.js";
import { FIRST_RUN_BANNED_DASHES, type FirstRunStepId } from "./visual-first-run.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
}
function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}
function step(): string | null {
  return q('[data-testid="first-run-step"]')?.getAttribute("data-step") ?? null;
}
function next(): HTMLButtonElement {
  return q<HTMLButtonElement>('[data-testid="first-run-next"]')!;
}

const ACME = { companyUid: "cmp_acme", slug: "acme-robotics", name: "Acme Robotics" };
const HARBOR = { companyUid: "cmp_harbor", slug: "blue-harbor", name: "Blue Harbor" };
const GRANOLA: FirstRunApp = { domain: "granola.ai", name: "Granola", description: "AI meeting notes", entryId: null, authClass: "none" };
const FATHOM: FirstRunApp = { domain: "fathom.video", name: "Fathom", description: "Calls", entryId: null, authClass: "oauth" };
const LOOM: FirstRunApp = { domain: "loom.com", name: "Loom", description: "Video", entryId: null, authClass: "key" };
const LINEAR: FirstRunApp = { domain: "linear.app", name: "Linear", description: "Issues", entryId: null, authClass: "none" };

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Render {
  initialStep?: FirstRunStepId;
  teamOptions?: FirstRunTeamOptions | null;
  team?: Partial<FirstRunTeamHost> | null;
  apps?: Partial<FirstRunAppsHost> | null;
}

function render(props: Render = {}) {
  const handlers = {
    onconfirmname: vi.fn(),
    onretry: vi.fn(),
    ontalk: vi.fn(),
    oncontinueinchat: vi.fn(),
    onsettled: vi.fn((_s: FirstRunSettled) => undefined),
  };
  const teamHost: FirstRunTeamHost | null =
    props.team === null
      ? null
      : {
          join: vi.fn(async (c) => ({ ok: true, choice: { kind: "company", how: "joined", company: c } }) as TeamActionResult),
          create: vi.fn(async (name: string) => ({
            ok: true,
            choice: { kind: "company", how: "created", company: { companyUid: "cmp_new", slug: "x", name } },
          }) as TeamActionResult),
          ...props.team,
        };
  const appsHost: FirstRunAppsHost | null =
    props.apps === null
      ? null
      : {
          catalog: vi.fn(async (_uid: string, kind: "notes" | "projects"): Promise<AppCatalogResult> => ({
            ok: true,
            apps: kind === "notes" ? [GRANOLA, FATHOM, LOOM] : [LINEAR],
            connected: [],
          })),
          connect: vi.fn(async (): Promise<AppConnectResult> => ({ ok: true })),
          ...props.apps,
        };
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(FirstRunTakeover, {
    target: host,
    props: {
      initialName: "Pickles",
      initialStep: props.initialStep ?? "team",
      creation: { state: "ready", name: "Pickles", bot: { agentUid: "agt_1", name: "Pickles" } },
      runtimeReady: { claude: true, codex: false, grok: false },
      teamOptions: props.teamOptions === undefined ? { invites: [ACME], companies: [HARBOR] } : props.teamOptions,
      teamHost,
      appsHost,
      ...handlers,
    },
  });
  return { handlers, teamHost, appsHost };
}

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
});

describe("Your team", () => {
  it("is one decision in the takeover's look: invites, companies, Start a company and Just me", async () => {
    render();
    await settle();
    expect(step()).toBe("team");
    expect(q("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Who do you work with?");
    // Six bars: every screen of the plan but the context scan, which needs a scan host.
    expect(document.querySelectorAll('[data-testid="new-bot-progress"] span')).toHaveLength(6);
    expect(q('[data-testid="new-bot-progress"]')?.getAttribute("aria-label")).toBe("Step 2 of 6");
    const kinds = [...document.querySelectorAll('[data-testid="first-run-team-grid"] [role="radio"]')].map((el) =>
      el.getAttribute("data-kind"),
    );
    expect(kinds).toEqual(["invite", "existing", "create", "personal"]);
    // The New bot company grid's cards.
    expect(q('[data-testid="first-run-team-invite:acme-robotics"]')?.classList.contains("new-bot-company")).toBe(true);
    // One company to its name: it is the default pick.
    expect(q('[data-testid="first-run-team-existing:blue-harbor"]')?.getAttribute("aria-checked")).toBe("true");
    expect(next().textContent).toContain("Next: Your coding tools");
    expect(q('[data-testid="first-run-finish"]')?.textContent).toContain("Finish with defaults");
    expect(q('[data-testid="first-run-continue-in-chat"]')).toBeTruthy();
    for (const dash of FIRST_RUN_BANNED_DASHES) expect(q('[data-testid="first-run-takeover"]')?.textContent).not.toContain(dash);
  });

  it("Join shows its pending label on the same press, ignores repeat presses, then moves on", async () => {
    const join = deferred<TeamActionResult>();
    const { teamHost, handlers } = render({ team: { join: vi.fn(() => join.promise) } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-team-invite:acme-robotics"]')!.click();
    flushSync();
    next().click();
    flushSync();
    expect(next().textContent).toContain("Joining Acme Robotics…");
    expect(next().disabled).toBe(true);
    expect(next().getAttribute("aria-busy")).toBe("true");
    next().click();
    next().click();
    await settle();
    expect(teamHost!.join).toHaveBeenCalledTimes(1);
    expect(teamHost!.join).toHaveBeenCalledWith(ACME);
    join.resolve({ ok: true, choice: { kind: "company", how: "joined", company: ACME } });
    await settle();
    expect(step()).toBe("tools");
    expect(handlers.onsettled).toHaveBeenLastCalledWith({
      team: { kind: "company", how: "joined", name: "Acme Robotics", slug: "acme-robotics" },
      apps: {},
    });
  });

  it("a failed join says why, with Retry and Continue in chat, and stays on the screen", async () => {
    const join = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "Couldn't join the company. Try again." })
      .mockResolvedValueOnce({ ok: true, choice: { kind: "company", how: "joined", company: ACME } });
    const { handlers } = render({ team: { join } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-team-invite:acme-robotics"]')!.click();
    next().click();
    await settle();
    expect(step()).toBe("team");
    const line = q('[data-testid="first-run-team-status"]');
    expect(line?.getAttribute("data-state")).toBe("failed");
    expect(line?.textContent).toContain("Couldn't join the company.");
    expect(q('[data-testid="first-run-live"]')?.textContent).toContain("Couldn't join the company.");
    q<HTMLButtonElement>('[data-testid="first-run-team-chat"]')!.click();
    await settle();
    expect(handlers.oncontinueinchat).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-testid="first-run-team-retry"]')!.click();
    await settle();
    expect(join).toHaveBeenCalledTimes(2);
    expect(step()).toBe("tools");
  });

  it("Start a company asks for a name, checks it, and creates once", async () => {
    const create = deferred<TeamActionResult>();
    const { teamHost } = render({ team: { create: vi.fn(() => create.promise) } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-team-create"]')!.click();
    await settle();
    const field = q<HTMLInputElement>('[data-testid="first-run-company-name"]')!;
    expect(field).toBeTruthy();
    next().click();
    await settle();
    expect(q('[data-testid="first-run-company-name-issue"]')?.textContent).toBe("Give your company a name.");
    expect(teamHost!.create).not.toHaveBeenCalled();
    field.value = "Pickle  Works";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    flushSync();
    expect(next().textContent).toContain("Starting Pickle Works…");
    next().click();
    await settle();
    expect(teamHost!.create).toHaveBeenCalledTimes(1);
    expect(teamHost!.create).toHaveBeenCalledWith("Pickle Works");
    create.resolve({ ok: true, choice: { kind: "company", how: "created", company: { companyUid: "cmp_new", slug: "pickle-works", name: "Pickle Works" } } });
    await settle();
    expect(step()).toBe("tools");
  });

  it('"Just me" moves on at once and leaves out the app screens', async () => {
    const { teamHost, handlers } = render();
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-team-personal"]')!.click();
    next().click();
    await settle();
    expect(step()).toBe("tools");
    expect(teamHost!.join).not.toHaveBeenCalled();
    expect(handlers.onsettled).toHaveBeenLastCalledWith({ team: { kind: "personal" }, apps: {} });
    // name, team, tools, done: no Note taker or Project management.
    expect(document.querySelectorAll('[data-testid="new-bot-progress"] span')).toHaveLength(4);
    expect(next().textContent).toContain("Next: Done");
  });

  it("Finish with defaults from the name step settles the default without joining anything", async () => {
    const { teamHost, handlers } = render({ initialStep: "name", teamOptions: { invites: [ACME], companies: [] } });
    await settle();
    q<HTMLButtonElement>('[data-testid="new-bot-finish-name"]')!.click();
    await settle();
    expect(step()).toBe("done");
    expect(teamHost!.join).not.toHaveBeenCalled();
    expect(handlers.onsettled).toHaveBeenLastCalledWith({ team: { kind: "personal" }, apps: {} });
    expect(q('[data-testid="first-run-summary-team"]')?.textContent).toBe("Just me");
  });
});

describe("Note taker and Project management", () => {
  it("lists the catalog's note takers, connects one inline with a pending state, and never holds Next", async () => {
    const connect = deferred<AppConnectResult>();
    const { appsHost } = render({ initialStep: "notes", apps: { connect: vi.fn(() => connect.promise) } });
    await settle();
    expect(step()).toBe("notes");
    expect(q("h1")?.textContent?.replace(/\s+/g, " ").trim()).toBe("Bring in your meeting notes.");
    expect(appsHost!.catalog).toHaveBeenCalledWith("cmp_harbor", "notes");
    expect(q('[data-testid="first-run-app-granola.ai"]')).toBeTruthy();
    // A key app is listed without a Connect button.
    expect(q('[data-testid="first-run-connect-loom.com"]')).toBeNull();
    expect(q('[data-testid="first-run-app-loom.com"]')?.textContent).toContain("Needs an access key");
    const button = q<HTMLButtonElement>('[data-testid="first-run-connect-granola.ai"]')!;
    button.click();
    flushSync();
    expect(button.textContent).toBe("Connecting…");
    expect(button.disabled).toBe(true);
    button.click();
    q<HTMLButtonElement>('[data-testid="first-run-connect-fathom.video"]')!.click();
    await settle();
    expect(appsHost!.connect).toHaveBeenCalledTimes(1);
    // Connecting never blocks Next.
    expect(next().disabled).toBe(false);
    connect.resolve({ ok: true });
    await settle();
    expect(q('[data-testid="first-run-notes-connected"]')?.textContent).toContain("Granola is connected to Blue Harbor.");
    expect(q('[data-testid="first-run-connect-granola.ai"]')?.textContent).toBe("Connected");
  });

  it("an OAuth app waits for the browser while the person moves on", async () => {
    const connect = deferred<AppConnectResult>();
    const { handlers } = render({ initialStep: "notes", apps: { connect: vi.fn(() => connect.promise) } });
    await settle();
    const button = q<HTMLButtonElement>('[data-testid="first-run-connect-fathom.video"]')!;
    button.click();
    flushSync();
    expect(button.textContent).toBe("Finish in your browser…");
    next().click();
    await settle();
    expect(step()).toBe("projects");
    connect.resolve({ ok: true });
    await settle();
    expect(handlers.onsettled).toHaveBeenLastCalledWith({
      team: null,
      apps: { notes: { name: "Fathom", domain: "fathom.video" } },
    });
  });

  it("a failed connect says why with Retry and Continue in chat; Retry connects again", async () => {
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: "Could not start the connection. Try again.", retry: true })
      .mockResolvedValueOnce({ ok: true });
    const { handlers } = render({ initialStep: "projects", apps: { connect } });
    await settle();
    q<HTMLButtonElement>('[data-testid="first-run-connect-linear.app"]')!.click();
    await settle();
    const line = q('[data-testid="first-run-projects-status"]');
    expect(line?.getAttribute("data-state")).toBe("failed");
    expect(line?.textContent).toContain("Could not start the connection.");
    q<HTMLButtonElement>('[data-testid="first-run-projects-chat"]')!.click();
    await settle();
    expect(handlers.oncontinueinchat).toHaveBeenCalledTimes(1);
    q<HTMLButtonElement>('[data-testid="first-run-projects-retry"]')!.click();
    await settle();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(q('[data-testid="first-run-projects-connected"]')).toBeTruthy();
  });

  it("Skip is Next with nothing connected: the screen counts as passed and Done says so", async () => {
    const { handlers, appsHost } = render({ initialStep: "projects" });
    await settle();
    expect(q('[data-testid="first-run-projects-hint"]')).toBeTruthy();
    next().click();
    await settle();
    expect(step()).toBe("done");
    expect(appsHost!.connect).not.toHaveBeenCalled();
    expect(handlers.onsettled).toHaveBeenLastCalledWith({ team: null, apps: { projects: null } });
    expect(q('[data-testid="first-run-summary-projects"]')?.textContent?.trim()).toBe("Skipped");
    expect(q('[data-testid="first-run-summary-notes"]')?.textContent?.trim()).toBe("Not set up");
  });

  it("a catalog the person may not read says so, with no Retry, and Next still works", async () => {
    render({
      initialStep: "notes",
      apps: { catalog: vi.fn(async () => ({ ok: false, reason: "Only company owners and admins can browse apps to connect.", retry: false })) },
    });
    await settle();
    expect(q('[data-testid="first-run-notes-catalog-failed"]')?.textContent).toContain("Only company owners and admins");
    expect(q('[data-testid="first-run-notes-reload"]')).toBeNull();
    next().click();
    await settle();
    expect(step()).toBe("projects");
  });
});

describe("hosts without the new screens (today's slice 1 and 4 takeover)", () => {
  it("shows no team or app screens when the host gives no team or apps host", async () => {
    render({ initialStep: "name", team: null, apps: null, teamOptions: null });
    await settle();
    expect(document.querySelectorAll('[data-testid="new-bot-progress"] span')).toHaveLength(3);
    expect(q('[data-testid="new-bot-continue-name"]')?.textContent).toContain("Next: Your coding tools");
  });
});
