// @vitest-environment happy-dom

/**
 * A sign-in finished in Settings > AI tools says so on the window, so a bot's
 * repair card still saying the tool is signed out checks again and turns to
 * "You're all set" in place. (DesktopApp's listener for the same event is
 * covered in DesktopApp.bot-sign-in.test.ts.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type PlatformAdapter } from "@hq/platform";

import AgentsSettingsPane from "./AgentsSettingsPane.svelte";
import {
  RUNTIME_SIGNED_IN_EVENT,
  RuntimeRepairController,
  signedInRuntimeOf,
} from "../chat/messaging/runtime-repair.svelte.js";
import type { RepairPayload } from "../chat/messaging/runtime-repair-model.js";

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;
const listeners: Array<(event: Event) => void> = [];

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  for (const listener of listeners.splice(0)) window.removeEventListener(RUNTIME_SIGNED_IN_EVENT, listener);
  vi.restoreAllMocks();
});

function render(sessions: Record<string, unknown>): void {
  const adapter = { sessions } as unknown as PlatformAdapter;
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(AgentsSettingsPane, { target: host, props: { adapter } });
}

async function clickConnect(): Promise<void> {
  let btn: HTMLButtonElement | undefined;
  await vi.waitFor(() => {
    flushSync();
    btn = [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("Connect") && !b.disabled);
    expect(btn).toBeDefined();
  });
  btn!.click();
}

const SIGNED_OUT: RepairPayload = {
  v: 1,
  kind: "runtime-repair",
  class: "signed-out",
  runtime: "claude",
  action: "signIn",
  botName: "setup",
};

describe("AgentsSettingsPane sign-in signal", () => {
  it("a Settings sign-in sends the signal, and the waiting signed-out card turns fixed", async () => {
    let signedIn = false;
    const controller = new RuntimeRepairController({
      signIn: async () => false,
      update: async () => false,
      setModel: async () => false,
      probe: async () => (signedIn ? { ok: true } : { ok: false, class: "signed-out" }),
    });
    controller.track("evt_repair", SIGNED_OUT);
    const heard: Array<string | null> = [];
    const listener = (event: Event): void => {
      const runtime = signedInRuntimeOf(event);
      heard.push(runtime);
      if (runtime) void controller.recheckSignIn({ runtime, force: true });
    };
    listeners.push(listener);
    window.addEventListener(RUNTIME_SIGNED_IN_EVENT, listener);

    render({
      preflight: vi.fn(async () => ok({ claudeAvailable: true, claudeLoggedIn: signedIn, codexAvailable: false, grokAvailable: false })),
      loginStart: vi.fn(async () => {
        signedIn = true;
        return ok({ state: "connected" });
      }),
    });
    await clickConnect();
    await vi.waitFor(() => expect(heard).toEqual(["claude"]));
    await vi.waitFor(() => expect(controller.stateFor("evt_repair")).toEqual({ phase: "fixed", action: "signIn" }));
  });

  it("a sign-in that does not finish sends nothing", async () => {
    const heard: Array<string | null> = [];
    const listener = (event: Event): void => void heard.push(signedInRuntimeOf(event));
    listeners.push(listener);
    window.addEventListener(RUNTIME_SIGNED_IN_EVENT, listener);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    render({
      preflight: vi.fn(async () => ok({ claudeAvailable: true, claudeLoggedIn: false, codexAvailable: false, grokAvailable: false })),
      loginStart: vi.fn(async () => ok({ state: "failed" })),
    });
    await clickConnect();
    await vi.waitFor(() => {
      flushSync();
      expect(host.textContent).toContain("Try again");
    });
    expect(heard).toEqual([]);
  });
});
