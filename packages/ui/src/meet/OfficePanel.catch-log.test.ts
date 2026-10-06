// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { ok, type Json } from "@hq/platform";
import OfficePanel from "./OfficePanel.svelte";

const SELF = "prs_self";
const PEER = "prs_peer";
const COMPANY = "cmp_acme";
const BASE = Date.parse("2026-08-13T12:00:00.000Z");

let host: HTMLDivElement | null = null;
let component: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host?.remove();
  host = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

class BlockedAudio {
  state = "suspended";
  resume(): Promise<void> {
    return Promise.reject(new Error("resume blocked"));
  }
  close(): Promise<void> {
    return Promise.reject(new Error("close blocked"));
  }
}

function knockWire(): Record<string, unknown> {
  return {
    knockId: "knk_1",
    companyUid: COMPANY,
    roomId: "room_peer",
    callId: "call_peer",
    epoch: 4,
    from: PEER,
    target: SELF,
    note: "two minutes",
    state: "pending",
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
    // OfficePanel announces with Date.now(). A fixture pinned to August is
    // already expired, so the store keeps the card and skips the nudge.
    expiresAt: Date.now() + 120_000,
  };
}

function person(personUid: string, room?: Record<string, unknown>) {
  return {
    personUid,
    connectivity: "online",
    connectivityExpiresAt: BASE + 600_000,
    willingness: "knock",
    willingnessExpiresAt: BASE + 600_000,
    occupancy: room ? "occupied" : "unoccupied",
    occupancyExpiresAt: room ? BASE + 600_000 : null,
    ...(room ? { room } : {}),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    flushSync();
    await Promise.resolve();
  }
}

describe("OfficePanel swallowed fallbacks", () => {
  it("logs member, notification, and audio failures and still shows the knock", async () => {
    vi.stubGlobal("AudioContext", BlockedAudio);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const adapter = {
      kind: "desktop",
      capabilities: { nativeCalls: true, osNotifications: true },
      isAvailable: () => true,
      company: {
        listMembers: async () => {
          throw new Error("members down");
        },
      },
      calls: {
        preflight: async () => ok({ passed: true } as never),
        discoverOffice: async () =>
          ok({
            companyUid: COMPANY,
            observedAt: BASE,
            people: [
              person(SELF),
              person(PEER, {
                roomId: "room_peer",
                callId: "call_peer",
                epoch: 4,
                participants: [PEER],
                visibility: "company",
              }),
            ],
          } as unknown as Json),
        setOfficePreference: async () => ok({} as Json),
        setOfficeConnectivity: async () => ok({} as Json),
        createRoom: async () => ok({} as Json),
        getRoom: async () => ok({} as Json),
        createKnock: async () => ok({} as Json),
        listKnocks: async () => ok({ knocks: [knockWire()] } as unknown as Json),
        getKnock: async () => ok(knockWire() as unknown as Json),
        respondToKnock: async () => ok({} as Json),
      },
      identity: { whoami: async () => ok({ personUid: SELF } as never) },
      messaging: { sendDm: async () => ok({} as Json) },
      appShell: {
        showOsNotification: async () => {
          throw new Error("notify down");
        },
      },
    };
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(OfficePanel as never, {
      target: host,
      props: {
        adapter,
        callsHost: {
          serviceEvidence: {},
          evidenceMaxAgeMs: 10_000_000,
          openCallWindow: vi.fn(async () => undefined),
          resolveDeviceId: async () => "dev_self",
        },
        companyUid: COMPANY,
        visible: true,
        knockPollMs: 60_000,
      } as never,
    });
    await settle();
    window.dispatchEvent(new Event("pointerdown"));
    await settle();

    expect(host.querySelector('[data-testid="knock-card-knk_1"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="office-host-refusal"]')).toBeNull();
    expect(warn).toHaveBeenCalledWith("office: member list failed", "members down");
    expect(warn).toHaveBeenCalledWith("office: knock notification failed", "notify down");
    expect(debug).toHaveBeenCalledWith("office: audio resume failed", "resume blocked");

    await unmount(component);
    component = null;
    await settle();
    expect(warn).toHaveBeenCalledWith("office: audio close failed", "close blocked");
  });
});
