/**
 * Speaking heuristic (US-020).
 *
 * A level threshold with hysteresis over a `SpeakingPort`'s audio levels. It is
 * a GUESS about audio energy, not diarization and not identity: nothing here
 * proves a person spoke, and every label the UI renders from it says "may be
 * speaking". No audio, no levels and no timings leave this module — only a
 * boolean per key-free peer label.
 */

export interface SpeakingTuning {
  /** Level at or above which a silent peer becomes "may be speaking". */
  onThreshold: number;
  /** Level below which a speaking peer goes quiet. Lower than `onThreshold`. */
  offThreshold: number;
  /** How long the level must stay below `offThreshold` before going quiet. */
  releaseMs: number;
}

export const SPEAKING_TUNING: Readonly<SpeakingTuning> = Object.freeze({
  onThreshold: 0.12,
  offThreshold: 0.06,
  releaseMs: 600,
});

export interface SpeakingTracker {
  /** Fold one level sample in. Returns true when the flag changed. */
  observe(peerId: string, level: number, at: number): boolean;
  /** Drop a peer entirely (left, removed, muted). */
  forget(peerId: string): void;
  /** Peers currently flagged, sorted for stable rendering. */
  speaking(): string[];
  /** Is this peer flagged right now? */
  isSpeaking(peerId: string): boolean;
}

interface Entry {
  speaking: boolean;
  quietSince: number | null;
}

export function createSpeakingTracker(
  tuning: Partial<SpeakingTuning> = {},
): SpeakingTracker {
  const config: SpeakingTuning = { ...SPEAKING_TUNING, ...tuning };
  const entries = new Map<string, Entry>();

  return {
    observe(peerId, level, at) {
      const entry = entries.get(peerId) ?? { speaking: false, quietSince: null };
      entries.set(peerId, entry);
      if (!entry.speaking) {
        if (level >= config.onThreshold) {
          entry.speaking = true;
          entry.quietSince = null;
          return true;
        }
        return false;
      }
      if (level >= config.offThreshold) {
        // Still loud enough: the release window restarts.
        entry.quietSince = null;
        return false;
      }
      if (entry.quietSince === null) {
        entry.quietSince = at;
        return false;
      }
      if (at - entry.quietSince >= config.releaseMs) {
        entry.speaking = false;
        entry.quietSince = null;
        return true;
      }
      return false;
    },
    forget(peerId) {
      entries.delete(peerId);
    },
    speaking() {
      return [...entries.entries()]
        .filter(([, entry]) => entry.speaking)
        .map(([peerId]) => peerId)
        .sort();
    },
    isSpeaking(peerId) {
      return entries.get(peerId)?.speaking === true;
    },
  };
}
