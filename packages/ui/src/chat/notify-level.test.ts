import { describe, expect, it, vi } from "vitest";

import {
  NOTIFY_LEVEL_OPTIONS,
  changeNotifyLevel,
  isMutedLevel,
  normalizeNotifyLevel,
  muteToggleLabel,
  toggledMuteLevel,
  unmuteLevel,
  notifyLevelErrorMessage,
  notifyLevelFromWire,
  type NotifyLevel,
} from "./notify-level";
import { normalizeDirectoryFeed } from "./live-directory";
import {
  applyChannelNotifyLevel,
  directoryRowToChannel,
  normalizeChannel,
} from "./sidebar-model";
import type { Channel } from "./channels";

describe("notify level parsing", () => {
  it("offers the four levels in order", () => {
    expect(NOTIFY_LEVEL_OPTIONS.map((o) => o.level)).toEqual([
      "all",
      "files",
      "mentions",
      "muted",
    ]);
  });

  it("normalizes wire values", () => {
    expect(normalizeNotifyLevel("muted")).toBe("muted");
    expect(normalizeNotifyLevel(" all ")).toBe("all");
    expect(normalizeNotifyLevel("loud")).toBeNull();
    expect(normalizeNotifyLevel(null)).toBeNull();
  });

  it("reads the flat desktop field or the server membership object", () => {
    expect(notifyLevelFromWire({ notifyLevel: "files" })).toBe("files");
    expect(
      notifyLevelFromWire({ membership: { joined: true, notifyLevel: "muted" } }),
    ).toBe("muted");
    // Browse-only rows carry a null level.
    expect(
      notifyLevelFromWire({ membership: { joined: false, notifyLevel: null } }),
    ).toBeNull();
    expect(notifyLevelFromWire({ membership: "joined" })).toBeNull();
  });

  it("labels the bell", () => {
    expect(muteToggleLabel("muted")).toBe("Unmute channel");
    expect(muteToggleLabel("all")).toBe("Mute channel");
    expect(muteToggleLabel(null)).toBe("Mute channel");
    expect(isMutedLevel("muted")).toBe(true);
    expect(isMutedLevel("all")).toBe(false);
  });

  it("maps server errors to copy", () => {
    expect(notifyLevelErrorMessage({ code: "CHANNEL_NOT_JOINED" })).toMatch(/Join this channel/);
    expect(notifyLevelErrorMessage({ code: "INVALID_NOTIFY_LEVEL" })).toMatch(/isn't supported/);
    expect(notifyLevelErrorMessage({ code: "http-404" })).toMatch(/doesn't support/);
    expect(notifyLevelErrorMessage({ code: "http-500", message: "boom" })).toBe("boom");
  });
});

describe("one-click mute toggle", () => {
  it("mutes any non-muted level", () => {
    expect(toggledMuteLevel("all", null)).toBe("muted");
    expect(toggledMuteLevel(null, null)).toBe("muted");
  });

  it("restores the remembered level, else mentions", () => {
    expect(toggledMuteLevel("muted", "files")).toBe("files");
    expect(toggledMuteLevel("muted", null)).toBe("mentions");
    expect(unmuteLevel("muted")).toBe("mentions");
  });
});

describe("changeNotifyLevel", () => {
  it("paints the new level before the server answers and keeps it on success", async () => {
    const painted: Array<NotifyLevel | null> = [];
    let resolve!: (v: { ok: true }) => void;
    const persist = vi.fn(
      () => new Promise<{ ok: true }>((done) => (resolve = done)),
    );
    const pending = changeNotifyLevel({
      previous: "all",
      next: "muted",
      apply: (level) => painted.push(level),
      persist,
    });
    expect(painted).toEqual(["muted"]);
    resolve({ ok: true });
    await expect(pending).resolves.toEqual({ ok: true });
    expect(painted).toEqual(["muted"]);
    expect(persist).toHaveBeenCalledWith("muted");
  });

  it("rolls back and reports on failure", async () => {
    const painted: Array<NotifyLevel | null> = [];
    const outcome = await changeNotifyLevel({
      previous: "mentions",
      next: "all",
      apply: (level) => painted.push(level),
      persist: async () => ({ ok: false, code: "CHANNEL_NOT_JOINED" }),
    });
    expect(painted).toEqual(["all", "mentions"]);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toMatch(/Join this channel/);
  });

  it("rolls back when the call throws", async () => {
    const painted: Array<NotifyLevel | null> = [];
    const outcome = await changeNotifyLevel({
      previous: null,
      next: "files",
      apply: (level) => painted.push(level),
      persist: async () => {
        throw new Error("offline");
      },
    });
    expect(painted).toEqual(["files", null]);
    expect(outcome).toEqual({ ok: false, error: "offline" });
  });

  it("is a no-op when the level does not change", async () => {
    const apply = vi.fn();
    const persist = vi.fn();
    await expect(
      changeNotifyLevel({ previous: "all", next: "all", apply, persist }),
    ).resolves.toEqual({ ok: true });
    expect(apply).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("notify level through the channel directory", () => {
  it("carries the level from list_channels rows onto sidebar rows", () => {
    const feed = normalizeDirectoryFeed({
      channels: [
        { channelId: "chn_a", name: "eng", scope: "company", notifyLevel: "muted" },
        {
          channelId: "chn_b",
          name: "ops",
          scope: "company",
          membership: { joined: true, notifyLevel: "files" },
        },
        { channelId: "chn_c", name: "old", scope: "company" },
      ],
    });
    const rows = feed.rows ?? [];
    expect(rows.map((r) => r.notifyLevel)).toEqual(["muted", "files", undefined]);
    const channel = directoryRowToChannel(rows[0]!);
    expect(channel.notifyLevel).toBe("muted");
    expect(normalizeChannel(channel).notifyLevel).toBe("muted");
    expect(normalizeChannel(directoryRowToChannel(rows[2]!)).notifyLevel).toBeUndefined();
  });

  it("keeps a known level when a later row omits it", () => {
    const prev: Channel = {
      channelId: "chn_a",
      name: "eng",
      scope: "company",
      notifyLevel: "muted",
    };
    const next = directoryRowToChannel(
      { channelId: "chn_a", name: "eng", scope: "company", lastActivityAt: null },
      prev,
    );
    expect(next.notifyLevel).toBe("muted");
  });

  it("applies an optimistic level to one channel", () => {
    const channels: Channel[] = [
      { channelId: "chn_a", name: "a", scope: "company", notifyLevel: "all" },
      { channelId: "chn_b", name: "b", scope: "company", notifyLevel: "all" },
    ];
    const next = applyChannelNotifyLevel(channels, "chn_b", "muted");
    expect(next.map((c) => c.notifyLevel)).toEqual(["all", "muted"]);
    expect(channels[1]!.notifyLevel).toBe("all");
  });
});

describe("unmute default and persistence", () => {
  it("defaults to all for group DMs and channels you created, else mentions", async () => {
    const { defaultNotifyLevel } = await import("./notify-level");
    expect(defaultNotifyLevel({ scope: "group" })).toBe("all");
    expect(defaultNotifyLevel({ kind: "group" })).toBe("all");
    expect(defaultNotifyLevel({ scope: "company", createdBy: "prs_me", selfUid: "prs_me" })).toBe("all");
    expect(defaultNotifyLevel({ scope: "company", createdBy: "prs_other", selfUid: "prs_me" })).toBe("mentions");
    expect(defaultNotifyLevel({ scope: "project" })).toBe("mentions");
  });

  it("persists remembered levels, dropping muted and junk", async () => {
    const {
      loadRememberedNotifyLevels,
      saveRememberedNotifyLevels,
      REMEMBERED_NOTIFY_LEVELS_KEY,
    } = await import("./notify-level");
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    saveRememberedNotifyLevels(storage, { chn_a: "files", chn_b: "all" });
    expect(loadRememberedNotifyLevels(storage)).toEqual({ chn_a: "files", chn_b: "all" });
    map.set(REMEMBERED_NOTIFY_LEVELS_KEY, JSON.stringify({ chn_a: "muted", chn_b: "loud", chn_c: "all" }));
    expect(loadRememberedNotifyLevels(storage)).toEqual({ chn_c: "all" });
    map.set(REMEMBERED_NOTIFY_LEVELS_KEY, "not json");
    expect(loadRememberedNotifyLevels(storage)).toEqual({});
    expect(loadRememberedNotifyLevels(null)).toEqual({});
    const throwing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(() => saveRememberedNotifyLevels(throwing, { chn_a: "all" })).not.toThrow();
  });

  it("carries createdBy from list rows onto sidebar rows", () => {
    const feed = normalizeDirectoryFeed({
      channels: [{ channelId: "chn_mine", name: "mine", scope: "company", createdBy: "prs_me" }],
    });
    const row = normalizeChannel(directoryRowToChannel(feed.rows![0]!));
    expect(row.createdBy).toBe("prs_me");
  });
});
