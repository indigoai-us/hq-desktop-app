import { describe, expect, it } from "vitest";
import { createSettingsUpdater, type SettingsWriteIo } from "./settings-write";

function fakeIo() {
  let prefs: Record<string, unknown> = { existing: 1 };
  const saves: Record<string, unknown>[] = [];
  const io: SettingsWriteIo = {
    async getSettings() {
      return { ok: true, value: { ...prefs } };
    },
    async saveSettings(next) {
      prefs = { ...next };
      saves.push({ ...next });
      return { ok: true, value: undefined };
    },
  };
  return { io, saves, prefs: () => prefs };
}

describe("settings mutation queue (desktop settings-mutations port)", () => {
  it("merges each patch over the latest persisted preferences", async () => {
    const { io, prefs } = fakeIo();
    const update = createSettingsUpdater(io);
    await update({ a: true });
    await update({ b: false });
    expect(prefs()).toEqual({ existing: 1, a: true, b: false });
  });

  it("serializes overlapping patches in submit order", async () => {
    const { io, saves } = fakeIo();
    const update = createSettingsUpdater(io);
    await Promise.all([update({ first: 1 }), update({ second: 2 })]);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toMatchObject({ first: 1, second: 2 });
  });

  it("rejects the failed patch but keeps later mutations runnable", async () => {
    let fail = true;
    const { io } = fakeIo();
    const flaky: SettingsWriteIo = {
      getSettings: io.getSettings,
      async saveSettings(next) {
        if (fail) return { ok: false, reason: "error", message: "disk full" };
        return io.saveSettings(next);
      },
    };
    const update = createSettingsUpdater(flaky);
    await expect(update({ a: 1 })).rejects.toThrow("disk full");
    fail = false;
    await expect(update({ b: 2 })).resolves.toBeUndefined();
  });

  it("surfaces unavailable as a rejection so controls can roll back", async () => {
    const unavailable: SettingsWriteIo = {
      async getSettings() {
        return { ok: false, reason: "unavailable", code: "desktop-only" };
      },
      async saveSettings() {
        return { ok: false, reason: "unavailable", code: "desktop-only" };
      },
    };
    const update = createSettingsUpdater(unavailable);
    await expect(update({ a: 1 })).rejects.toThrow(/unavailable/);
  });
});
