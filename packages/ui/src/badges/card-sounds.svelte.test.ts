// @vitest-environment happy-dom
/**
 * hq-accomplishment-badges US-016: sounds for the launch announcement.
 *
 * Owner, 2026-10-15: "let's generate a couple more for each effect and then
 * have each group randomly cycle through the options for each action. also we
 * need a sound effect for the introduction of the full screen accomplishments
 * launch." Then: "Build the in-app sounds PR now (random cycling, quiet by
 * default, off with reduced motion, mute toggle in Settings ...)".
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plays = vi.hoisted(() => ({ calls: [] as Array<[string, number]>, disposed: 0 }));

vi.mock("./card-sounds.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./card-sounds.js")>();
  return {
    ...real,
    createCardSounds: () => ({
      play: (action: string, delayMs = 0) => void plays.calls.push([action, delayMs]),
      dispose: () => void (plays.disposed += 1),
    }),
  };
});

import BadgeLaunchAnnouncement from "./BadgeLaunchAnnouncement.svelte";
import PrototypeSettingsPanes from "../settings/PrototypeSettingsPanes.svelte";
import { resolveEarned } from "./badge-catalog.js";
import { CARD_SOUNDS, createRandomCycler, soundEffectsAllowed, type SoundContextLike } from "./card-sounds.js";
import { readSoundEffectsEnabled, SOUND_EFFECTS_STORAGE_KEY, writeSoundEffectsEnabled } from "../settings/settings-prefs.js";
import { installMemoryLocalStorage } from "../test-support/memory-local-storage.js";

const realCardSounds = await vi.importActual<typeof import("./card-sounds.js")>("./card-sounds.js");
const here = dirname(fileURLToPath(import.meta.url));
const storage = installMemoryLocalStorage();

const EARNED = resolveEarned([
  { id: "founding", earnedAt: "2026-03-02" },
  { id: "maker", tier: 2, earnedAt: "2026-10-01" },
  { id: "fleet", tier: 3, earnedAt: "2026-08-01" },
]);

function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  plays.calls.length = 0;
  plays.disposed = 0;
  storage.clear();
  setReducedMotion(false);
});

describe("the sound set", () => {
  it("has four takes for every action, each a small MP3 shipped next to the code", () => {
    for (const [action, urls] of Object.entries(CARD_SOUNDS)) {
      expect(urls, action).toHaveLength(4);
      expect(new Set(urls).size, action).toBe(4);
      for (const url of urls) {
        const file = join(here, "sounds", decodeURIComponent(new URL(url).pathname.split("/").pop()!));
        const bytes = readFileSync(file);
        // ID3 tag or an MPEG frame sync.
        expect(bytes.subarray(0, 3).toString("latin1") === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0), file).toBe(true);
        // Short cuts; the intro swell is the longest at under four seconds.
        expect(statSync(file).size, file).toBeLessThan(action === "intro" ? 60_000 : 16_000);
      }
    }
  });
});

describe("random cycling", () => {
  it("never plays the same take twice in a row, and reaches every take", () => {
    const next = createRandomCycler(["a", "b", "c", "d"]);
    let last = "";
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const pick = next();
      expect(pick).not.toBe(last);
      seen.add(pick);
      last = pick;
    }
    expect(seen).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("follows the random source, skipping the previous pick", () => {
    const next = createRandomCycler(["a", "b", "c"], () => 0);
    expect([next(), next(), next(), next()]).toEqual(["a", "b", "a", "b"]);
  });
});

describe("the player", () => {
  function fakeContext() {
    const started: Array<{ buffer: unknown; when: number }> = [];
    const ctx: SoundContextLike & { started: typeof started; closed: boolean } = {
      currentTime: 10,
      state: "running",
      destination: {},
      started,
      closed: false,
      resume: async () => undefined,
      close: async () => void (ctx.closed = true),
      decodeAudioData: async (data) => ({ decodedFrom: data.byteLength }),
      createBufferSource: () => {
        const source = { buffer: null as unknown, connect: () => source, start: (when = 0) => void started.push({ buffer: source.buffer, when }) };
        return source;
      },
    };
    return ctx;
  }

  it("schedules each take on the audio clock and decodes a file once", async () => {
    const ctx = fakeContext();
    const load = vi.fn(async () => new ArrayBuffer(8));
    // A fixed wall clock: decoding time must not count against the deadline here.
    const sounds = realCardSounds.createCardSounds({ enabled: () => true, createContext: () => ctx, load, random: () => 0, now: () => 0 });
    sounds.play("deal", 500);
    sounds.play("deal", 0);
    sounds.play("deal", 0);
    await vi.waitFor(() => expect(ctx.started).toHaveLength(3));
    expect(ctx.started[0]!.when).toBeCloseTo(10.5);
    // deal-a, deal-b, deal-a: two files, each fetched and decoded once.
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("drops sounds it cannot start on time instead of firing them in a burst later", async () => {
    // A context that starts suspended (no gesture yet) keeps its clock at 0;
    // the hand's sounds must not all play when it finally starts.
    const ctx = Object.assign(fakeContext(), { state: "suspended", currentTime: 0 });
    let wall = 0;
    const sounds = realCardSounds.createCardSounds({ enabled: () => true, createContext: () => ctx, load: async () => new ArrayBuffer(8), now: () => wall });
    sounds.play("intro");
    sounds.play("deal", 420);
    await new Promise((r) => setTimeout(r, 0));
    expect(ctx.started).toEqual([]);
    // Running again, but past the moment: still nothing from the old queue.
    Object.assign(ctx, { state: "running" });
    wall = 5000;
    sounds.play("dismiss");
    await vi.waitFor(() => expect(ctx.started).toHaveLength(1));
  });

  it("plays nothing and opens no audio device when sound is not allowed", async () => {
    const createContext = vi.fn(fakeContext);
    const sounds = realCardSounds.createCardSounds({ enabled: () => false, createContext, load: async () => new ArrayBuffer(8) });
    sounds.play("intro");
    sounds.play("hover");
    await Promise.resolve();
    expect(createContext).not.toHaveBeenCalled();
  });

  it("is allowed by default, and not when turned off in Settings or under reduced motion", () => {
    expect(soundEffectsAllowed()).toBe(true);
    writeSoundEffectsEnabled(false);
    expect(soundEffectsAllowed()).toBe(false);
    writeSoundEffectsEnabled(true);
    setReducedMotion(true);
    expect(soundEffectsAllowed()).toBe(false);
  });
});

describe("the announcement", () => {
  let view: ReturnType<typeof mount> | null = null;
  afterEach(async () => {
    if (view) await unmount(view);
    view = null;
    document.body.innerHTML = "";
  });

  function open(badges = EARNED) {
    view = mount(BadgeLaunchAnnouncement, { target: document.body, props: { badges, onclose: () => {}, onopenbadges: () => {} } });
    flushSync();
    return document.querySelector<HTMLElement>('[data-testid="badge-launch"]')!;
  }

  it("opens with the intro, then deals and turns every card and lands the hand once", () => {
    open();
    const names = plays.calls.map(([a]) => a);
    expect(names[0]).toBe("intro");
    expect(names.filter((a) => a === "deal")).toHaveLength(3);
    expect(names.filter((a) => a === "flip")).toHaveLength(3);
    expect(names.filter((a) => a === "land")).toHaveLength(1);
    // Each card turns after it is dealt, and the hand lands after the last deal.
    const at = (a: string) => plays.calls.filter(([n]) => n === a).map(([, ms]) => ms);
    expect(Math.min(...at("flip"))).toBeGreaterThan(Math.min(...at("deal")));
    expect(at("land")[0]!).toBeGreaterThan(Math.max(...at("deal")));
  });

  it("deals the three face-down cards without turning them when nothing is earned yet", () => {
    open([]);
    const names = plays.calls.map(([a]) => a);
    expect(names.filter((a) => a === "deal")).toHaveLength(3);
    expect(names).not.toContain("flip");
  });

  it("plays nothing under reduced motion", () => {
    setReducedMotion(true);
    const root = open();
    (root.querySelector<HTMLButtonElement>('[data-testid="badge-launch-later"]'))!.click();
    expect(plays.calls.filter(([a]) => a !== "dismiss")).toEqual([]);
  });

  it("ticks under the pointer only once the hand has settled, and settles on the way out", async () => {
    vi.useFakeTimers();
    try {
      const root = open();
      const slot = root.querySelector<HTMLElement>(".la-slot")!;
      plays.calls.length = 0;
      slot.dispatchEvent(new PointerEvent("pointerenter"));
      expect(plays.calls).toEqual([]);
      vi.advanceTimersByTime(3000);
      flushSync();
      slot.dispatchEvent(new PointerEvent("pointerenter"));
      expect(plays.calls).toEqual([["hover", 0]]);
      root.querySelector<HTMLButtonElement>('[data-testid="badge-launch-later"]')!.click();
      expect(plays.calls.at(-1)).toEqual(["dismiss", 0]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases the audio device when it closes", async () => {
    open();
    await unmount(view!);
    view = null;
    expect(plays.disposed).toBe(1);
  });
});

describe("the Settings switch", () => {
  it("is on by default and turns sound effects off for this device", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panes = mount(PrototypeSettingsPanes, { target: host, props: { section: "appearance", storage, deviceStorage: storage } });
    await tick();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="settings-sound-effects"]')!;
    expect(toggle.getAttribute("aria-label")).toBe("Sound effects");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(readSoundEffectsEnabled(storage)).toBe(true);
    toggle.click();
    await tick();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(storage.getItem(SOUND_EFFECTS_STORAGE_KEY)).toBe("off");
    expect(soundEffectsAllowed()).toBe(false);
    await unmount(panes);
    host.remove();
  });
});
