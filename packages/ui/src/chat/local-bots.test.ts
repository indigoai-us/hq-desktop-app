import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import {
  lastHeartbeatLabel,
  localBotForRow,
  localBotOfflineNotice,
  localBotPresence,
} from "./local-bots.js";

const bot = (over: Partial<LocalBotRow> = {}): LocalBotRow => ({
  name: "scout",
  agentUid: "agt_01LOCAL",
  ownerUid: "prs_me",
  runtime: "claude",
  state: "running",
  pid: 42,
  processAlive: true,
  online: true,
  lastHeartbeatAt: "2026-09-10T12:00:00.000Z",
  daemonInstalled: true,
  daemonLoaded: true,
  dir: "/Users/me/.hq/bots/scout",
  ...over,
});

describe("local bot presence (US-009)", () => {
  it("matches a DM row to the bot behind its agt_ uid", () => {
    expect(localBotForRow([bot()], { kind: "dm", personUid: "agt_01LOCAL" })?.name).toBe("scout");
    expect(localBotForRow([bot()], { kind: "dm", personUid: "agt_OTHER" })).toBeNull();
    expect(localBotForRow([bot()], { kind: "channel", personUid: "agt_01LOCAL" })).toBeNull();
    expect(localBotForRow([bot()], null)).toBeNull();
  });
  it("is online only on the server's say-so", () => {
    expect(localBotPresence([bot()], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("online");
    expect(localBotPresence([bot({ online: false })], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("offline");
    expect(localBotPresence([bot({ online: null, processAlive: true })], { kind: "dm", personUid: "agt_01LOCAL" })).toBe("offline");
    expect(localBotPresence([bot()], { kind: "dm", personUid: "prs_human" })).toBeNull();
  });
  it("explains why a bot is not answering", () => {
    expect(localBotOfflineNotice(bot({ online: false, processAlive: false, state: "stopped" }))).toMatch(/computer is off or the bot is stopped/);
    expect(localBotOfflineNotice(bot({ online: false, processAlive: true }))).toMatch(/starting up/);
    expect(localBotOfflineNotice(bot({ online: false, processAlive: false, state: "failed" }))).toMatch(/repeated errors/);
  });
  it("formats the last heartbeat relatively", () => {
    const now = Date.parse("2026-09-10T12:01:00.000Z");
    expect(lastHeartbeatLabel("2026-09-10T12:00:45.000Z", now)).toBe("checked in 15s ago");
    expect(lastHeartbeatLabel("2026-09-10T11:30:00.000Z", now)).toBe("checked in 31m ago");
    expect(lastHeartbeatLabel(null, now)).toBeNull();
    expect(lastHeartbeatLabel("garbage", now)).toBeNull();
  });
});
