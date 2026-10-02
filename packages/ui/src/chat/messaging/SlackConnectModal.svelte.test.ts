// @vitest-environment happy-dom

// The Connect Slack flow inside the Slack card's modal: one stage at a time,
// read from the bot's status. Attach is sent only from Start. The pasted
// token never leaves the field and the one request that carries it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import SlackConnectModal from "./SlackConnectModal.svelte";
import type { CardModalContentProps } from "./card-modal-registry.js";
import { SLACK_FINISHING_SLOW_MS, SLACK_TOKEN_ACCEPT_GRACE_MS } from "./slack-connect-model.js";

/** An obviously fake app-level token. Never a real one. */
const TOKEN = "xapp-test-0000";
const NOVA = "agt_nova";
const INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0TEST";
const FRESH_INSTALL = "https://slack.com/oauth/v2/authorize?client_id=1.2&scope=chat%3Awrite&state=A0FRESH";
const APP = "https://api.slack.com/apps/A0TEST";

function status(slack: Record<string, unknown> | null, capability = "unknown") {
  return {
    setupState: { phase: "ready" },
    agent: {
      uid: NOVA,
      companyUid: "cmp_acme",
      channels: slack ? { slack } : null,
      channelDiagnostics: { slack: { inboundCapability: capability } },
    },
  };
}

const NO_SLACK = status(null);
const SOCKET_ROW = { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP };
const WAITING_FOR_APPROVAL = status(SOCKET_ROW, "pending-install");
const WAITING_FOR_TOKEN = status(
  { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket", appTokenPendingUrl: APP },
  "socket-mode-degraded",
);
const WAITING_FOR_ACCESS = status(
  { workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket", appTokenAccessPending: "Adding you to the app." },
  "socket-mode-degraded",
);
const TOKEN_STORED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" }, "socket-mode-degraded");
const CONNECTED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "socket" }, "socket-mode");
const EVENTS_ROW = { workspace: "pending-install", installUrl: INSTALL, appId: "A0TEST", connectionMode: "events" };
const EVENTS_INSTALLED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "events" }, "unknown");
const EVENTS_CONNECTED = status({ workspace: "acme", teamId: "T0ACME", appId: "A0TEST", connectionMode: "events" }, "ok");

const refusal = (code: string, httpStatus?: number) => ({
  ok: false as const,
  reason: "error" as const,
  code,
  message: "server text that is never shown",
  ...(httpStatus ? { status: httpStatus } : {}),
});

let shell: HTMLDivElement;
let message: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
let props: CardModalContentProps;
let clock = 0;
/** What the server would say now. `refresh` hands it to the modal, as the shell does. */
let serverStatus: unknown = NO_SLACK;
let attachSlack: ReturnType<typeof vi.fn>;
let submitSlackAppToken: ReturnType<typeof vi.fn>;
let openUrl: ReturnType<typeof vi.fn<(url: string) => void>>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
let started: ReturnType<typeof vi.fn<() => void>>;
let onclose: ReturnType<typeof vi.fn<() => void>>;

beforeEach(() => {
  clock = Date.parse("2026-10-02T15:00:00.000Z");
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  window.localStorage.clear();
  window.sessionStorage.clear();
  shell = document.createElement("div");
  shell.className = "desktop-shell";
  shell.setAttribute("data-shell-focus-fallback", "");
  shell.tabIndex = -1;
  message = document.createElement("div");
  shell.appendChild(message);
  document.body.appendChild(shell);
  serverStatus = NO_SLACK;
  attachSlack = vi.fn(async () => ok({ config: SOCKET_ROW, followUpUrl: INSTALL }));
  submitSlackAppToken = vi.fn(async () => ok({ ok: true }));
  openUrl = vi.fn<(url: string) => void>();
  started = vi.fn<() => void>();
  onclose = vi.fn<() => void>();
  refresh = vi.fn(async () => {
    props.status = serverStatus;
    props.checkedAt = clock;
  });
});

afterEach(async () => {
  await takeDown();
  shell.remove();
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

function render(over: Partial<CardModalContentProps> = {}): void {
  const adapter = { agents: { attachSlack, submitSlackAppToken } } as unknown as PlatformAdapter;
  const state = $state<CardModalContentProps>({
    frame: { open: true, title: "Slack", icon: "slack", art: "/art/aurora.jpg", artPosition: "center", onclose },
    agentUid: NOVA,
    target: "slack",
    botName: "Nova",
    companyUid: "cmp_acme",
    companySlug: "acme",
    status: NO_SLACK,
    statusDenied: false,
    checkedAt: clock,
    adapter,
    openUrl,
    refresh,
    started,
    ...over,
  });
  props = state;
  component = mount(SlackConnectModal, { target: message, props });
  flushSync();
}

/** Take the modal down without closing it: what the shell does when the conversation changes. */
async function takeDown(): Promise<void> {
  if (component) await unmount(component);
  component = null;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await tick();
    await Promise.resolve();
  }
  flushSync();
}

/** The shell's check came back with what the server says now. */
async function check(next: unknown): Promise<void> {
  serverStatus = next;
  props.status = next;
  props.checkedAt = clock;
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[data-testid="card-modal"]')!;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`);
const stage = () => byId("slack-connect")!.dataset.stage;
const title = () => byId("card-modal-title")!.textContent;
const steps = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="card-modal-step"]')].map(
    (el) => `${el.dataset.state}:${el.querySelector(".card-modal-step-text")!.textContent!.replace(/^Step \d+(, done)?: /, "").trim()}`,
  );
const statusLines = () =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="card-modal-status"]')].map(
    (el) => `${el.dataset.kind}:${el.textContent!.trim()}`,
  );
const indicator = () => byId("card-modal-steps-text")?.textContent ?? null;
const footerButtons = () =>
  [...byId("card-modal-footer")!.querySelectorAll<HTMLButtonElement>("button")].map((el) => el.textContent!.trim());
const startButton = () => byId<HTMLButtonElement>("slack-connect-start")!;
const tokenField = () => byId("slack-connect-token")?.querySelector<HTMLInputElement>("input") ?? null;
const submitButton = () => byId<HTMLButtonElement>("slack-connect-submit")!;
const fieldError = () => byId("card-modal-field-error")?.textContent ?? null;
const closeX = () => byId<HTMLButtonElement>("card-modal-close")!;

function paste(value: string): void {
  const input = tokenField()!;
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flushSync();
}

/** Everything a test can reach that must never hold the token. */
function expectTokenNowhere(): void {
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i += 1) {
      const name = store.key(i)!;
      expect(name).not.toContain(TOKEN);
      expect(store.getItem(name) ?? "").not.toContain(TOKEN);
    }
  }
  expect(window.location.href).not.toContain(TOKEN);
  expect(document.body.innerHTML).not.toContain(TOKEN);
  for (const input of document.querySelectorAll("input")) expect(input.value).not.toContain(TOKEN);
  expect(JSON.stringify(openUrl.mock.calls)).not.toContain(TOKEN);
}

describe("the Connect Slack modal: each stage", () => {
  it("opens on the intro: two lines, a Start button, no steps, and nothing asked of the server", () => {
    render();
    expect(stage()).toBe("intro");
    expect(title()).toBe("Connect Nova to Slack");
    expect(dialog().dataset.icon).toBe("slack");
    expect(byId("slack-connect-intro")!.textContent).toContain("You approve Nova in your Slack workspace.");
    expect(byId("slack-connect-intro")!.textContent).toContain("Then Nova can read and answer messages there.");
    expect(steps()).toEqual([]);
    expect(indicator()).toBeNull();
    expect(footerButtons()).toEqual(["Start"]);
    expect(document.activeElement).toBe(startButton());
    expect(attachSlack).not.toHaveBeenCalled();
    expect(submitSlackAppToken).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it("shows approve: step 1 current with Open Slack, the rest to do", () => {
    render({ status: WAITING_FOR_APPROVAL });
    expect(stage()).toBe("approve");
    expect(steps()).toEqual(["current:Approve Nova in Slack", "todo:Create a token for Nova", "todo:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 1 of 3: Approve in Slack");
    expect(dialog().textContent).toContain("Slack opens in your browser. Come back here when you have approved.");
    expect(byId("slack-connect-open-slack")!.textContent!.trim()).toBe("Open Slack");
    expect(document.activeElement).toBe(byId("slack-connect-open-slack"));
    expect(footerButtons()).toEqual(["Close"]);
    expect(tokenField()).toBeNull();
  });

  it("shows token: step 2 current with the four instructions, the app page button and a password field", () => {
    render({ status: WAITING_FOR_TOKEN });
    expect(stage()).toBe("token");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "current:Create a token for Nova", "todo:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 2 of 3: Add the token");
    const howto = [...byId("slack-connect-howto")!.querySelectorAll("li")].map((li) =>
      li.querySelector(".slack-connect-howto-line")!.textContent!.trim(),
    );
    expect(howto).toEqual([
      "Open Nova's app page in Slack.",
      "Scroll to App-Level Tokens and click Generate Token and Scopes.",
      "Name it anything, add the scope connections:write, and click Generate.",
      "Copy the token (it starts with xapp-) and paste it here.",
    ]);
    expect(byId("slack-connect-open-app-page")!.textContent!.trim()).toBe("Open app page");
    const input = tokenField()!;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(input.hasAttribute("name")).toBe(false);
    expect(document.querySelector(`label[for="${input.id}"]`)!.textContent).toBe("Token");
    expect(document.activeElement).toBe(input);
    expect(footerButtons()).toEqual(["Connect"]);
    // Nothing to send yet.
    expect(submitButton().disabled).toBe(true);
  });

  it("shows token with access pending: the waiting sentence, no instructions and no field", () => {
    render({ status: WAITING_FOR_ACCESS });
    expect(stage()).toBe("token");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "current:Create a token for Nova", "todo:HQ finishes the setup"]);
    expect(statusLines()).toEqual([
      "working:HQ is giving you access to Nova's app in Slack. This can take up to 15 minutes. This screen updates by itself.",
    ]);
    expect(byId("slack-connect-howto")).toBeNull();
    expect(tokenField()).toBeNull();
    expect(byId("slack-connect-submit")).toBeNull();
    expect(footerButtons()).toEqual(["Close"]);
  });

  it("shows the field by itself once the app page link arrives", async () => {
    render({ status: WAITING_FOR_ACCESS });
    expect(tokenField()).toBeNull();
    await check(WAITING_FOR_TOKEN);
    expect(tokenField()).not.toBeNull();
    expect(byId("slack-connect-open-app-page")).not.toBeNull();
  });

  it("shows finishing: the last step current with the working line", () => {
    render({ status: TOKEN_STORED });
    expect(stage()).toBe("finishing");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:Create a token for Nova", "current:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 3 of 3: Connecting");
    expect(statusLines()).toEqual(["working:Connecting Nova to Slack. This usually takes a minute or two."]);
    expect(footerButtons()).toEqual(["Close"]);
    expect(closeX().disabled).toBe(false);
  });

  it("says the calmer line after three minutes in the last step, keeps checking, and is no error", async () => {
    render({ status: TOKEN_STORED });
    await settle();
    expect(byId("slack-connect-waiting")!.dataset.slow).toBe("false");
    clock += SLACK_FINISHING_SLOW_MS + 1_000;
    await check(TOKEN_STORED);
    expect(stage()).toBe("finishing");
    expect(byId("slack-connect-waiting")!.dataset.slow).toBe("true");
    expect(statusLines()).toEqual([
      "working:Still connecting. You can close this. The Slack card updates when Nova is in Slack.",
    ]);
    expect(document.querySelector('[data-testid="card-modal-status"][data-kind="problem"]')).toBeNull();
    // And it still ends by itself.
    await check(CONNECTED);
    expect(stage()).toBe("connected");
  });

  it("shows connected: every step done, the sentence, and Done closes", () => {
    render({ status: CONNECTED });
    expect(stage()).toBe("connected");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:Create a token for Nova", "done:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 3 of 3: Connected");
    expect(statusLines()).toEqual(["done:Nova is in Slack. Invite it to a channel or send it a direct message."]);
    expect(footerButtons()).toEqual(["Done"]);
    // No button that claims to send a test message.
    expect(dialog().textContent).not.toMatch(/send (a )?test/i);
    byId<HTMLButtonElement>("slack-connect-finish")!.click();
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it("shows two steps for a bot the server asks no token for, and never a token step", async () => {
    attachSlack.mockResolvedValueOnce(ok({ config: EVENTS_ROW, followUpUrl: INSTALL }));
    serverStatus = status(EVENTS_ROW, "pending-install");
    render();
    startButton().click();
    await settle();
    expect(steps()).toEqual(["current:Approve Nova in Slack", "todo:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 1 of 2: Approve in Slack");
    await check(EVENTS_INSTALLED);
    expect(stage()).toBe("finishing");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "current:HQ finishes the setup"]);
    expect(tokenField()).toBeNull();
    await check(EVENTS_CONNECTED);
    expect(stage()).toBe("connected");
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:HQ finishes the setup"]);
    expect(indicator()).toBe("Step 2 of 2: Connected");
    expect(submitSlackAppToken).not.toHaveBeenCalled();
  });

  it("moves on by itself when the status changes, and puts focus on the new step", async () => {
    render({ status: WAITING_FOR_APPROVAL });
    byId<HTMLButtonElement>("slack-connect-open-slack")!.focus();
    await check(WAITING_FOR_TOKEN);
    expect(stage()).toBe("token");
    expect(document.activeElement).toBe(tokenField());
    await check(TOKEN_STORED);
    expect(stage()).toBe("finishing");
    expect(document.activeElement).toBe(byId("slack-connect-close"));
    await check(CONNECTED);
    expect(document.activeElement).toBe(byId("slack-connect-finish"));
  });
});

describe("the Connect Slack modal: Start and attach", () => {
  it("never calls attach when it opens, at any stage", async () => {
    for (const json of [NO_SLACK, null, WAITING_FOR_APPROVAL, WAITING_FOR_TOKEN, WAITING_FOR_ACCESS, TOKEN_STORED, CONNECTED]) {
      render({ status: json });
      await settle();
      expect(attachSlack).not.toHaveBeenCalled();
      await takeDown();
    }
  });

  it("offers no way to attach when the bot already has Slack", async () => {
    for (const json of [WAITING_FOR_APPROVAL, WAITING_FOR_TOKEN, WAITING_FOR_ACCESS, TOKEN_STORED, CONNECTED]) {
      render({ status: json });
      expect(byId("slack-connect-start")).toBeNull();
      // Press everything the stage offers.
      for (const button of dialog().querySelectorAll<HTMLButtonElement>("button")) {
        if (!button.disabled) button.click();
      }
      await settle();
      expect(attachSlack).not.toHaveBeenCalled();
      await takeDown();
    }
  });

  it("calls attach once from Start, even on a double click, and holds the modal while it is on its way", async () => {
    let finish: (value: unknown) => void = () => {};
    attachSlack.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    serverStatus = WAITING_FOR_APPROVAL;
    render();
    startButton().click();
    startButton().click();
    await settle();
    startButton().click();
    await settle();
    expect(attachSlack).toHaveBeenCalledTimes(1);
    expect(attachSlack).toHaveBeenCalledWith(NOVA);
    expect(startButton().disabled).toBe(true);
    expect(statusLines()).toEqual(["working:Setting things up in Slack."]);
    // Busy: the modal cannot be closed under the request.
    expect(closeX().disabled).toBe(true);
    expect(dialog().getAttribute("aria-busy")).toBe("true");
    expect(started).not.toHaveBeenCalled();

    finish(ok({ config: SOCKET_ROW, followUpUrl: INSTALL }));
    await settle();
    expect(attachSlack).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stage()).toBe("approve");
    expect(closeX().disabled).toBe(false);
    expect(byId("slack-connect-start")).toBeNull();
  });

  it("shows the step list from the attach answer before the status catches up", async () => {
    // The status read after the attach fails: the modal still knows what it made.
    refresh.mockImplementationOnce(async () => {});
    render();
    startButton().click();
    await settle();
    expect(stage()).toBe("approve");
    expect(steps()).toHaveLength(3);
    byId<HTMLButtonElement>("slack-connect-open-slack")!.click();
    expect(openUrl).toHaveBeenCalledWith(INSTALL);
  });

  it("reads the status first when it is not known, and does not attach over a setup that exists", async () => {
    serverStatus = WAITING_FOR_TOKEN;
    render({ status: null });
    expect(stage()).toBe("intro");
    startButton().click();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(attachSlack).not.toHaveBeenCalled();
    expect(stage()).toBe("token");
  });

  it("reads the status first when it is not known, then attaches when the bot has no Slack", async () => {
    let asked = 0;
    refresh.mockImplementation(async () => {
      asked += 1;
      props.status = asked === 1 ? NO_SLACK : WAITING_FOR_APPROVAL;
    });
    render({ status: null });
    startButton().click();
    await settle();
    expect(attachSlack).toHaveBeenCalledTimes(1);
    expect(stage()).toBe("approve");
  });

  it("does not attach while the status cannot be read, and says to try again", async () => {
    refresh.mockImplementation(async () => {});
    render({ status: null });
    startButton().click();
    await settle();
    expect(attachSlack).not.toHaveBeenCalled();
    expect(stage()).toBe("intro");
    expect(statusLines()).toEqual(["problem:Slack did not answer. Try again."]);
    expect(footerButtons()).toEqual(["Try again"]);
  });

  it("goes on from the status when the server says Slack is already connected", async () => {
    attachSlack.mockResolvedValueOnce(refusal("SLACK_ATTACH_ALREADY_CONNECTED", 409));
    serverStatus = CONNECTED;
    render();
    startButton().click();
    await settle();
    expect(stage()).toBe("connected");
    expect(document.querySelector('[data-testid="card-modal-status"][data-kind="problem"]')).toBeNull();
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("stays on the intro with Try again when Slack did not answer", async () => {
    for (const failure of [refusal("SLACK_FACTORY_ROTATE_UNAVAILABLE", 409), refusal("CHANNEL_ATTACH_FAILED", 502), refusal("network")]) {
      attachSlack.mockReset();
      attachSlack.mockResolvedValueOnce(failure);
      render();
      startButton().click();
      await settle();
      expect(stage()).toBe("intro");
      expect(statusLines()).toEqual(["problem:Slack did not answer. Try again."]);
      expect(footerButtons()).toEqual(["Try again"]);
      expect(started).not.toHaveBeenCalled();
      // Try again asks once more, and works.
      attachSlack.mockResolvedValueOnce(ok({ config: SOCKET_ROW, followUpUrl: INSTALL }));
      serverStatus = WAITING_FOR_APPROVAL;
      startButton().click();
      await settle();
      expect(attachSlack).toHaveBeenCalledTimes(2);
      expect(stage()).toBe("approve");
      await takeDown();
      serverStatus = NO_SLACK;
      started.mockClear();
    }
  });

  it("treats a request that throws as Slack not answering", async () => {
    attachSlack.mockRejectedValueOnce(new Error("offline"));
    render();
    startButton().click();
    await settle();
    expect(stage()).toBe("intro");
    expect(statusLines()).toEqual(["problem:Slack did not answer. Try again."]);
  });
});

describe("the Connect Slack modal: approving in Slack", () => {
  it("opens the install link in the browser from Open Slack", () => {
    render({ status: WAITING_FOR_APPROVAL });
    byId<HTMLButtonElement>("slack-connect-open-slack")!.click();
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(openUrl).toHaveBeenCalledWith(INSTALL);
    expect(started).toHaveBeenCalledTimes(1);
    expect(attachSlack).not.toHaveBeenCalled();
  });

  it("uses a fresher link when the status shows one", async () => {
    render({ status: WAITING_FOR_APPROVAL });
    await check(status({ ...SOCKET_ROW, installUrl: FRESH_INSTALL }, "pending-install"));
    byId<HTMLButtonElement>("slack-connect-open-slack")!.click();
    expect(openUrl).toHaveBeenCalledWith(FRESH_INSTALL);
  });

  it("offers no button for a link that is not Slack's", () => {
    render({ status: status({ ...SOCKET_ROW, installUrl: "https://example.com/phish" }, "pending-install") });
    expect(stage()).toBe("approve");
    expect(byId("slack-connect-open-slack")).toBeNull();
    expect(dialog().textContent).toContain("Waiting for the link from Slack. This screen updates by itself.");
    expect(document.activeElement).toBe(byId("slack-connect-close"));
  });

  it("opens the app's page at /general from Open app page", () => {
    render({ status: WAITING_FOR_TOKEN });
    byId<HTMLButtonElement>("slack-connect-open-app-page")!.click();
    expect(openUrl).toHaveBeenCalledWith(`${APP}/general`);
  });
});

describe("the Connect Slack modal: the token", () => {
  it("sends the token once, clears the field the moment the server accepts it, and moves to the last step", async () => {
    let finish: (value: unknown) => void = () => {};
    submitSlackAppToken.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    expect(submitButton().disabled).toBe(false);
    submitButton().click();
    submitButton().click();
    await settle();
    // Enter while the first is on its way does nothing either.
    tokenField()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(submitSlackAppToken).toHaveBeenCalledTimes(1);
    expect(submitSlackAppToken).toHaveBeenCalledWith(NOVA, TOKEN);
    expect(statusLines()).toEqual(["working:Checking the token with Slack."]);
    expect(closeX().disabled).toBe(true);

    serverStatus = TOKEN_STORED;
    const field = tokenField()!;
    finish(ok({ ok: true }));
    await settle();
    expect(field.value).toBe("");
    expect(stage()).toBe("finishing");
    expect(tokenField()).toBeNull();
    expect(steps()).toEqual(["done:Approve Nova in Slack", "done:Create a token for Nova", "current:HQ finishes the setup"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalled();
    expectTokenNowhere();
  });

  it("moves to the last step on accept even before the status catches up", async () => {
    refresh.mockImplementation(async () => {});
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    expect(stage()).toBe("finishing");
    expectTokenNowhere();
  });

  it("has forgotten the accepted token: a field that comes back is empty", async () => {
    // The status never catches up, so after a while the server's word wins and
    // the token step comes back. What was pasted before must not come with it.
    refresh.mockImplementation(async () => {});
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    expect(stage()).toBe("finishing");
    clock += SLACK_TOKEN_ACCEPT_GRACE_MS + 1_000;
    await check(WAITING_FOR_TOKEN);
    expect(stage()).toBe("token");
    expect(tokenField()!.value).toBe("");
    expect(submitButton().disabled).toBe(true);
    expectTokenNowhere();
  });

  it("submits on Enter, with the spaces around the token taken off", async () => {
    serverStatus = TOKEN_STORED;
    render({ status: WAITING_FOR_TOKEN });
    paste(`  ${TOKEN} `);
    tokenField()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await settle();
    expect(submitSlackAppToken).toHaveBeenCalledTimes(1);
    expect(submitSlackAppToken).toHaveBeenCalledWith(NOVA, TOKEN);
  });

  it("sends nothing for something that is not the right kind of token", async () => {
    render({ status: WAITING_FOR_TOKEN });
    for (const wrong of ["bot-test-0000", "xapp-test 0000", "xapp-"]) {
      paste(wrong);
      submitButton().click();
      await settle();
      expect(fieldError()).toBe("That does not look like the right token. It starts with xapp-.");
      expect(tokenField()!.getAttribute("aria-invalid")).toBe("true");
    }
    expect(submitSlackAppToken).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(tokenField());
    // Typing again takes the sentence away.
    paste(TOKEN);
    expect(fieldError()).toBeNull();
  });

  it("shows the rejection sentence, clears what was pasted and keeps focus in the field", async () => {
    for (const code of ["SLACK_APP_TOKEN_INVALID", "SLACK_APP_TOKEN_REJECTED"]) {
      submitSlackAppToken.mockResolvedValueOnce(refusal(code, 400));
      render({ status: WAITING_FOR_TOKEN });
      paste(TOKEN);
      submitButton().focus();
      submitButton().click();
      await settle();
      expect(stage()).toBe("token");
      expect(fieldError()).toBe(
        "Slack did not accept that token. Check that it starts with xapp- and has the connections:write scope.",
      );
      expect(tokenField()!.value).toBe("");
      expect(document.activeElement).toBe(tokenField());
      expect(closeX().disabled).toBe(false);
      expectTokenNowhere();
      await takeDown();
    }
  });

  it("keeps the value in the field, and nowhere else, when the token could not be checked", async () => {
    for (const failure of [refusal("SLACK_APP_TOKEN_VERIFY_UNAVAILABLE", 502), refusal("network")]) {
      submitSlackAppToken.mockReset();
      submitSlackAppToken.mockResolvedValueOnce(failure);
      render({ status: WAITING_FOR_TOKEN });
      paste(TOKEN);
      submitButton().click();
      await settle();
      expect(fieldError()).toBe("Could not check the token with Slack. Try again.");
      expect(tokenField()!.value).toBe(TOKEN);
      expect(document.activeElement).toBe(tokenField());
      for (const store of [window.localStorage, window.sessionStorage]) expect(store.length).toBe(0);
      expect(document.body.innerHTML).not.toContain(TOKEN);
      // The retry sends the same value and works.
      submitSlackAppToken.mockResolvedValueOnce(ok({ ok: true }));
      serverStatus = TOKEN_STORED;
      submitButton().click();
      await settle();
      expect(submitSlackAppToken).toHaveBeenCalledTimes(2);
      expect(submitSlackAppToken).toHaveBeenLastCalledWith(NOVA, TOKEN);
      expect(stage()).toBe("finishing");
      expectTokenNowhere();
      await takeDown();
      serverStatus = NO_SLACK;
    }
  });

  it("drops a request that throws without reading it, and lets the person try again", async () => {
    submitSlackAppToken.mockRejectedValueOnce(new Error(`could not send {"appToken":"${TOKEN}"}`));
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    expect(fieldError()).toBe("Could not check the token with Slack. Try again.");
    expect(document.body.innerHTML).not.toContain(TOKEN);
  });

  it("goes on from the status when the server was not waiting for a token", async () => {
    submitSlackAppToken.mockResolvedValueOnce(refusal("SLACK_APP_TOKEN_NOT_AWAITED", 409));
    serverStatus = CONNECTED;
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stage()).toBe("connected");
    expectTokenNowhere();
  });

  it("clears the token when the modal is closed", async () => {
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    const field = tokenField()!;
    closeX().click();
    await settle();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("");
    expectTokenNowhere();
    expect(submitSlackAppToken).not.toHaveBeenCalled();
  });

  it("clears the token on Escape", async () => {
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    const field = tokenField()!;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    expect(onclose).toHaveBeenCalledTimes(1);
    expect(field.value).toBe("");
    expectTokenNowhere();
  });

  it("clears the token when the modal is taken down, as when the conversation changes", async () => {
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    const field = tokenField()!;
    expect(field.value).toBe(TOKEN);
    await takeDown();
    expect(field.value).toBe("");
    expect(onclose).not.toHaveBeenCalled();
    expectTokenNowhere();
  });

  it("does not act on an answer that arrives after the modal is gone", async () => {
    let finish: (value: unknown) => void = () => {};
    submitSlackAppToken.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    await takeDown();
    finish(ok({ ok: true }));
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    expectTokenNowhere();
  });

  it("leaves no token in storage, the page, a link or a log after a full run", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    serverStatus = WAITING_FOR_APPROVAL;
    render();
    startButton().click();
    await settle();
    byId<HTMLButtonElement>("slack-connect-open-slack")!.click();
    await check(WAITING_FOR_TOKEN);
    byId<HTMLButtonElement>("slack-connect-open-app-page")!.click();
    paste(TOKEN);
    serverStatus = TOKEN_STORED;
    submitButton().click();
    await settle();
    expect(stage()).toBe("finishing");
    await check(CONNECTED);
    expect(stage()).toBe("connected");
    byId<HTMLButtonElement>("slack-connect-finish")!.click();
    await settle();

    expect(attachSlack).toHaveBeenCalledTimes(1);
    expect(submitSlackAppToken).toHaveBeenCalledTimes(1);
    expectTokenNowhere();
    expect(JSON.stringify(setItem.mock.calls)).not.toContain(TOKEN);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN);
    expect(openUrl.mock.calls.map(([url]) => url)).toEqual([INSTALL, `${APP}/general`]);
  });
});

describe("the Connect Slack modal: blocked", () => {
  const cases: Array<{
    name: string;
    failure: ReturnType<typeof refusal>;
    reason: string;
    sentence: string;
    button: string | null;
    url?: string;
  }> = [
    {
      name: "a person who is not an owner or admin (404)",
      failure: refusal("http-404", 404),
      reason: "not-admin",
      sentence: "Only a company owner or admin can connect a bot to Slack.",
      button: null,
    },
    {
      name: "a person who is not an owner or admin (403)",
      failure: refusal("http-403", 403),
      reason: "not-admin",
      sentence: "Only a company owner or admin can connect a bot to Slack.",
      button: null,
    },
    {
      name: "a company whose Slack is not connected to HQ",
      failure: refusal("FACTORY_ROOT_MISSING", 400),
      reason: "company-not-connected",
      sentence:
        "Your company's Slack is not connected to HQ yet. A company admin connects it once in HQ Integrations, then you can add Nova here.",
      button: "Open HQ Integrations",
      url: "https://hq.computer/companies/acme/integrations",
    },
    {
      name: "a company that uses its own Slack app",
      failure: refusal("SLACK_PASTE_REQUIRED", 409),
      reason: "own-app",
      sentence: "Your company connects bots with its own Slack app. That setup is on the web for now.",
      button: "Open Slack setup",
      url: "https://hq.computer/companies/acme/agents",
    },
    {
      name: "a company whose old setup no longer works",
      failure: refusal("LEGACY_FACTORY_CONFIG_TOKEN_DEAD", 400),
      reason: "config-dead",
      sentence: "Nova could not be added to Slack from here. Contact HQ support.",
      button: null,
    },
    {
      name: "a bot that would have to change apps",
      failure: refusal("SLACK_ATTACH_APP_SWITCH_NOT_WIRED", 400),
      reason: "app-switch",
      sentence: "Nova could not be added to Slack from here. Contact HQ support.",
      button: null,
    },
  ];

  for (const c of cases) {
    it(`shows the sentence and its one button for ${c.name}`, async () => {
      attachSlack.mockResolvedValueOnce(c.failure);
      render();
      startButton().click();
      await settle();
      expect(stage()).toBe("blocked");
      expect(byId("slack-connect-blocked")!.dataset.reason).toBe(c.reason);
      expect(statusLines()).toEqual([`problem:${c.sentence}`]);
      expect(steps()).toEqual([]);
      expect(indicator()).toBeNull();
      expect(footerButtons()).toEqual(c.button ? ["Close", c.button] : ["Close"]);
      // No retry: nothing here asks the server to set Slack up again.
      expect(byId("slack-connect-start")).toBeNull();
      expect(started).not.toHaveBeenCalled();
      if (c.button) {
        byId<HTMLButtonElement>("slack-connect-blocked-action")!.click();
        expect(openUrl).toHaveBeenCalledTimes(1);
        expect(openUrl).toHaveBeenCalledWith(c.url);
      }
      byId<HTMLButtonElement>("slack-connect-close")!.click();
      expect(onclose).toHaveBeenCalledTimes(1);
      expect(attachSlack).toHaveBeenCalledTimes(1);
    });
  }

  it("opens the web's front page, never a page named by the uid, when the company's slug is not known", async () => {
    for (const [failure, slug] of [
      [refusal("FACTORY_ROOT_MISSING", 400), null],
      [refusal("SLACK_PASTE_REQUIRED", 409), null],
      [refusal("FACTORY_ROOT_MISSING", 400), "cmp_acme"],
    ] as const) {
      attachSlack.mockResolvedValueOnce(failure);
      render({ companySlug: slug });
      startButton().click();
      await settle();
      byId<HTMLButtonElement>("slack-connect-blocked-action")!.click();
      expect(openUrl).toHaveBeenLastCalledWith("https://hq.computer");
      await takeDown();
    }
    expect(JSON.stringify(openUrl.mock.calls)).not.toContain("cmp_");
  });

  it("is blocked from the start, with no Start button, for a person who may not read the bot's status", async () => {
    render({ status: null, statusDenied: true });
    expect(stage()).toBe("blocked");
    expect(statusLines()).toEqual(["problem:Only a company owner or admin can connect a bot to Slack."]);
    expect(footerButtons()).toEqual(["Close"]);
    expect(document.activeElement).toBe(byId("slack-connect-close"));
    await settle();
    expect(attachSlack).not.toHaveBeenCalled();
  });

  it("is blocked when the token is refused for a person who is not an owner or admin", async () => {
    submitSlackAppToken.mockResolvedValueOnce(refusal("http-404", 404));
    render({ status: WAITING_FOR_TOKEN });
    paste(TOKEN);
    submitButton().click();
    await settle();
    expect(stage()).toBe("blocked");
    expectTokenNowhere();
  });
});
