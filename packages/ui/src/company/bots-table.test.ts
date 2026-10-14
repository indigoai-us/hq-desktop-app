import { describe, expect, it } from "vitest";
import type { LocalBotRow } from "@hq/platform";
import type { CloudBotRow } from "../settings/cloud-bots.js";
import {
  BOT_COLUMNS,
  CLOUD_STALE_MS,
  cloudBotStatus,
  cloudRosterExtras,
  cloudTableRow,
  engineLabel,
  gridTemplate,
  lastSeenLabel,
  localBotStatus,
  localTableRow,
  sortBotRows,
  visibleBotColumns,
  type BotTableRow,
} from "./bots-table.js";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

function local(over: Partial<LocalBotRow> = {}): LocalBotRow {
  return {
    name: "scout",
    agentUid: "agt_local",
    ownerUid: "prs_me",
    runtime: "claude",
    state: "stopped",
    pid: null,
    processAlive: false,
    online: null,
    lastHeartbeatAt: null,
    daemonInstalled: false,
    daemonLoaded: false,
    ...over,
  } as LocalBotRow;
}

function cloud(over: Partial<CloudBotRow> = {}): CloudBotRow {
  return {
    uid: "agt_cloud",
    displayName: "Ranger",
    avatarUrl: null,
    companyUid: "cmp_a",
    companyLabel: "Acme",
    status: "IDLE",
    phase: "ready",
    machineInstanceId: null,
    canManage: true,
    ...over,
  };
}

function row(over: Partial<BotTableRow>): BotTableRow {
  return {
    uid: "u",
    name: "n",
    handle: null,
    avatarUrl: null,
    kind: "cloud",
    host: "Cloud",
    engine: null,
    owner: null,
    role: null,
    activity: null,
    live: false,
    lastSeenAt: null,
    status: "ready",
    canPause: false,
    ...over,
  };
}

describe("status ladder", () => {
  it("local: failed beats a hold, a hold beats running, running is ready, else offline", () => {
    expect(localBotStatus(local({ state: "failed", promotionHold: { companyUid: null } }))).toBe("error");
    expect(localBotStatus(local({ state: "running", promotionHold: { companyUid: "cmp_a" } }))).toBe("waiting");
    expect(localBotStatus(local({ state: "running" }))).toBe("ready");
    expect(localBotStatus(local({ state: "stopped", online: true }))).toBe("ready");
    expect(localBotStatus(local({ state: "stopped", busy: true }))).toBe("ready");
    expect(localBotStatus(local({ state: "stopped" }))).toBe("offline");
  });

  it("cloud: failed setup is error, setting up is waiting, working is ready", () => {
    expect(cloudBotStatus({ phase: "failed", status: "PROVISIONING" }, null, NOW)).toBe("error");
    expect(cloudBotStatus({ phase: "provisioning", status: "PROVISIONING" }, null, NOW)).toBe("waiting");
    expect(cloudBotStatus({ phase: "ready", status: "WORKING" }, ago(600), NOW)).toBe("ready");
  });

  it("cloud: a ready bot goes offline only after the stale window", () => {
    const window = CLOUD_STALE_MS / 60000;
    expect(cloudBotStatus({ phase: "ready", status: "IDLE" }, ago(window - 1), NOW)).toBe("ready");
    expect(cloudBotStatus({ phase: "ready", status: "IDLE" }, ago(window + 1), NOW)).toBe("offline");
    // No heartbeat reported: trust the setup phase.
    expect(cloudBotStatus({ phase: "ready", status: "IDLE" }, null, NOW)).toBe("ready");
  });
});

describe("rows", () => {
  it("a local row carries handle, host, engine, owner and busy activity", () => {
    const r = localTableRow(local({ displayName: "Scout", runtime: "codex", model: "gpt-5", busy: true, busySince: ago(2), state: "running" }), "Corey");
    expect(r).toMatchObject({ name: "Scout", handle: "scout", host: "This Mac", engine: "Codex · gpt-5", owner: "Corey", activity: "Answering a message", live: true, status: "ready", lastSeenAt: ago(2) });
    expect(localTableRow(local(), null).handle).toBeNull();
  });

  it("a cloud row reads the roster's slug, runtime, role and last activity", () => {
    const extras = cloudRosterExtras({ agents: [{ agentUid: "agt_cloud", slug: "ranger-bot", runtimeKind: "hermes", membershipRole: "member", lastActiveAt: ago(5), external: { lastHeartbeatAt: ago(5) } }] });
    const r = cloudTableRow(cloud(), extras.get("agt_cloud"), NOW);
    expect(r).toMatchObject({ handle: "ranger-bot", host: "External", engine: "Hermes", role: "Member", lastSeenAt: ago(5), status: "ready", owner: null });
    expect(cloudTableRow(cloud({ status: "WORKING" }), undefined, NOW)).toMatchObject({ activity: "Working", live: true, host: "Cloud", engine: null });
  });

  it("engine label joins runtime and model and leaves an unknown runtime readable", () => {
    expect(engineLabel("claude", "opus")).toBe("Claude · opus");
    expect(engineLabel("newthing")).toBe("Newthing");
    expect(engineLabel(null)).toBeNull();
  });

  it("last seen reads in plain words", () => {
    expect(lastSeenLabel(ago(0), NOW)).toBe("now");
    expect(lastSeenLabel(ago(4), NOW)).toBe("4 min ago");
    expect(lastSeenLabel(ago(180), NOW)).toBe("3 h ago");
    expect(lastSeenLabel(ago(60 * 48), NOW)).toBe("2 d ago");
    expect(lastSeenLabel(null, NOW)).toBe("");
  });
});

describe("sort", () => {
  const rows = [
    row({ uid: "off", name: "Off", status: "offline", lastSeenAt: ago(500) }),
    row({ uid: "err", name: "Err", status: "error", lastSeenAt: ago(1) }),
    row({ uid: "rdy", name: "Rdy", status: "ready", lastSeenAt: ago(30) }),
    row({ uid: "wait", name: "Wait", status: "waiting", lastSeenAt: null }),
    row({ uid: "live", name: "Live", status: "ready", live: true, lastSeenAt: ago(10) }),
  ];
  const ids = (list: BotTableRow[]) => list.map((r) => r.uid);

  it("status follows the ladder, most recent first inside a step", () => {
    expect(ids(sortBotRows(rows, "status", "asc"))).toEqual(["live", "rdy", "wait", "err", "off"]);
    expect(ids(sortBotRows(rows, "status", "desc"))).toEqual(["off", "err", "wait", "live", "rdy"]);
  });

  it("last seen descending puts the most recent first and unknown last", () => {
    expect(ids(sortBotRows(rows, "lastSeen", "desc"))).toEqual(["err", "live", "rdy", "off", "wait"]);
  });

  it("live first keeps live bots on top whatever the sort", () => {
    expect(ids(sortBotRows(rows, "lastSeen", "desc", { liveFirst: true }))[0]).toBe("live");
    expect(ids(sortBotRows(rows, "status", "desc", { liveFirst: true }))[0]).toBe("live");
  });
});

describe("column model", () => {
  const full = [row({ engine: "Claude", owner: "Corey", role: "Member", activity: "Working" })];

  it("shows every column on a wide table, in display order", () => {
    expect(visibleBotColumns(2000, full).map((c) => c.key)).toEqual(BOT_COLUMNS.map((c) => c.key));
  });

  it("leaves out columns no row has data for", () => {
    const keys = visibleBotColumns(2000, [row({})]).map((c) => c.key);
    expect(keys).not.toContain("engine");
    expect(keys).not.toContain("owner");
    expect(keys).not.toContain("role");
    expect(keys).not.toContain("activity");
    expect(keys).toContain("status");
  });

  it("drops the lowest-value columns first as the table narrows", () => {
    const at = (w: number) => visibleBotColumns(w, full).map((c) => c.key);
    expect(at(700)).not.toContain("role");
    expect(at(700)).not.toContain("owner");
    expect(at(700)).toContain("status");
    expect(at(700)).toContain("lastSeen");
    // The narrowest table keeps avatar, name and status.
    expect(at(280)).toEqual(["avatar", "name", "status"]);
  });

  it("never drops below avatar and name", () => {
    expect(visibleBotColumns(10, full).map((c) => c.key)).toEqual(["avatar", "name"]);
  });

  it("fits: the chosen minimum widths never exceed the width", () => {
    for (const w of [300, 420, 560, 700, 900]) {
      const cols = visibleBotColumns(w, full);
      const need = cols.reduce((s, c) => s + c.min, 0) + 12 * (cols.length - 1);
      expect(need).toBeLessThanOrEqual(w);
    }
    expect(gridTemplate(visibleBotColumns(280, full))).toBe("24px minmax(140px, 2fr) 84px");
  });
});
