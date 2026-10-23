/**
 * Sounds for the accomplishments announcement (US-016): a soft swell as it
 * opens, then card foley as the hand is dealt, turned over and lands, a tick
 * under the pointer, and a paper settle when it closes.
 *
 * Each action has four takes, generated with Google Lyria 3 Clip and Veo 3.1
 * Lite and trimmed to a few hundred milliseconds. An action plays one of its
 * takes at random and never the same take twice in a row, so a hand of five
 * cards does not sound like one sample repeated.
 *
 * Nothing plays when the person turned sound effects off in Settings
 * (Appearance), or when the system asks for reduced motion. The files are
 * mastered quiet; the player adds no gain of its own.
 */
import { readSoundEffectsEnabled } from "../settings/settings-prefs.js";
import { prefersReducedMotion } from "./badge-card.js";

export type CardSoundAction = "intro" | "deal" | "flip" | "land" | "hover" | "dismiss";

// Literal URLs, so the bundler emits each file as an asset.
export const CARD_SOUNDS: Readonly<Record<CardSoundAction, readonly string[]>> = {
  intro: [
    new URL("./sounds/intro-a.mp3", import.meta.url).href,
    new URL("./sounds/intro-b.mp3", import.meta.url).href,
    new URL("./sounds/intro-c.mp3", import.meta.url).href,
    new URL("./sounds/intro-d.mp3", import.meta.url).href,
  ],
  deal: [
    new URL("./sounds/deal-a.mp3", import.meta.url).href,
    new URL("./sounds/deal-b.mp3", import.meta.url).href,
    new URL("./sounds/deal-c.mp3", import.meta.url).href,
    new URL("./sounds/deal-d.mp3", import.meta.url).href,
  ],
  flip: [
    new URL("./sounds/flip-a.mp3", import.meta.url).href,
    new URL("./sounds/flip-b.mp3", import.meta.url).href,
    new URL("./sounds/flip-c.mp3", import.meta.url).href,
    new URL("./sounds/flip-d.mp3", import.meta.url).href,
  ],
  land: [
    new URL("./sounds/land-a.mp3", import.meta.url).href,
    new URL("./sounds/land-b.mp3", import.meta.url).href,
    new URL("./sounds/land-c.mp3", import.meta.url).href,
    new URL("./sounds/land-d.mp3", import.meta.url).href,
  ],
  hover: [
    new URL("./sounds/hover-a.mp3", import.meta.url).href,
    new URL("./sounds/hover-b.mp3", import.meta.url).href,
    new URL("./sounds/hover-c.mp3", import.meta.url).href,
    new URL("./sounds/hover-d.mp3", import.meta.url).href,
  ],
  dismiss: [
    new URL("./sounds/dismiss-a.mp3", import.meta.url).href,
    new URL("./sounds/dismiss-b.mp3", import.meta.url).href,
    new URL("./sounds/dismiss-c.mp3", import.meta.url).href,
    new URL("./sounds/dismiss-d.mp3", import.meta.url).href,
  ],
};

/** A random pick from `options` that never repeats the previous pick. */
export function createRandomCycler<T>(options: readonly T[], random: () => number = Math.random): () => T {
  let last: T | undefined;
  return () => {
    const pool = options.length > 1 ? options.filter((o) => o !== last) : options;
    const pick = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
    last = pick;
    return pick;
  };
}

/** The parts of an AudioContext the player uses, so tests can stand one in. */
export interface SoundContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  createBufferSource(): { buffer: unknown; connect(node: unknown): unknown; start(when?: number): void };
}

/** A sound that cannot start within this long of its moment is dropped. */
const LATE_MS = 250;

export interface CardSoundsOptions {
  /** Defaults to the stored Settings value and the reduced-motion query. */
  enabled?: () => boolean;
  createContext?: () => SoundContextLike | null;
  load?: (url: string) => Promise<ArrayBuffer>;
  random?: () => number;
  /** Wall-clock milliseconds; performance.now() by default. */
  now?: () => number;
}

export interface CardSounds {
  /** Play one take of `action`, `delayMs` from now. */
  play(action: CardSoundAction, delayMs?: number): void;
  /** Stop everything and release the audio device. */
  dispose(): void;
}

export function soundEffectsAllowed(): boolean {
  return readSoundEffectsEnabled() && !prefersReducedMotion();
}

function browserContext(): SoundContextLike | null {
  const Ctor = (globalThis as { AudioContext?: new () => SoundContextLike }).AudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`card sound ${response.status}`);
  return response.arrayBuffer();
}

export function createCardSounds(options: CardSoundsOptions = {}): CardSounds {
  const enabled = options.enabled ?? soundEffectsAllowed;
  const createContext = options.createContext ?? browserContext;
  const load = options.load ?? fetchBytes;
  const now = options.now ?? (() => performance.now());
  const cyclers = Object.fromEntries(
    (Object.keys(CARD_SOUNDS) as CardSoundAction[]).map((action) => [action, createRandomCycler(CARD_SOUNDS[action], options.random)]),
  ) as Record<CardSoundAction, () => string>;
  const buffers = new Map<string, Promise<unknown>>();
  let context: SoundContextLike | null = null;
  let disposed = false;

  function decoded(ctx: SoundContextLike, url: string): Promise<unknown> {
    let pending = buffers.get(url);
    if (!pending) {
      pending = load(url).then((bytes) => ctx.decodeAudioData(bytes));
      // A failed load is retried next time instead of being cached.
      pending.catch(() => buffers.delete(url));
      buffers.set(url, pending);
    }
    return pending;
  }

  return {
    play(action, delayMs = 0) {
      if (disposed || !enabled()) return;
      context ??= createContext();
      const ctx = context;
      if (!ctx) return;
      const url = cyclers[action]();
      // The deadline is wall-clock time: a suspended context's clock stands
      // still, so sounds queued while it was blocked would otherwise all
      // fire together the moment it starts (after the hand is long dealt).
      const due = now() + Math.max(0, delayMs);
      void ctx.resume().catch(() => undefined);
      decoded(ctx, url)
        .then((buffer) => {
          const late = now() - due;
          if (disposed || ctx.state !== "running" || late > LATE_MS) return;
          const source = ctx.createBufferSource();
          source.buffer = buffer;
          source.connect(ctx.destination);
          source.start(ctx.currentTime + Math.max(0, -late) / 1000);
        })
        .catch((error: unknown) => {
          console.debug("badges: card sound failed", error instanceof Error ? error.message : String(error));
        });
    },
    dispose() {
      disposed = true;
      const ctx = context;
      context = null;
      // Let a closing sound (dismiss) ring out before the device is released.
      if (ctx) setTimeout(() => void ctx.close().catch(() => undefined), 1200);
    },
  };
}
