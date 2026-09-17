/**
 * The call window's speaking heuristic and device enumeration (US-020).
 *
 * Both are the DOM half of ports that stay platform-pure elsewhere: meet-core
 * owns the hysteresis (`createSpeakingTracker`) and `@hq/ui` owns the picker,
 * and neither may touch `window`. This file is the only place that does.
 *
 * The speaking signal is an audio-LEVEL heuristic and is labelled as one
 * everywhere it surfaces. It is not diarization: it never claims a person
 * spoke, no audio leaves the analyser, and no level is logged or snapshot.
 */

import type { SpeakingLevelEvent, SpeakingPort, TrackLike } from "@hq/meet-core";
import type { MediaDeviceOption, MediaDevicesPort } from "@hq/ui";

/** How often a track is sampled. Cheap enough to run for eight tiles. */
export const SPEAKING_SAMPLE_MS = 120;

/** The structural subset of `AudioContext` the analyser needs. */
export interface AnalyserLike {
  readonly fftSize: number;
  getByteTimeDomainData(array: Uint8Array): void;
  disconnect(): void;
}

export interface AudioSourceLike {
  connect(destination: AnalyserLike): void;
  disconnect(): void;
}

export interface AudioContextLike {
  createAnalyser(): AnalyserLike;
  createMediaStreamSource(stream: unknown): AudioSourceLike;
  close(): Promise<void>;
}

export interface SpeakingPortOptions {
  /** Injected so tests never need WebAudio. Null disables the heuristic. */
  audioContext?: () => AudioContextLike | null;
  /** Wraps a track in the stream WebAudio needs. Injected for the same reason. */
  streamFor?: (track: TrackLike) => unknown;
  sampleMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

interface Observed {
  analyser: AnalyserLike;
  source: AudioSourceLike;
  buffer: Uint8Array;
}

/**
 * Root-mean-square of one time-domain window, normalised to roughly 0..1.
 * A level, not a transcript: the samples are read and discarded in place.
 */
function levelOf(analyser: AnalyserLike, buffer: Uint8Array): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const sample of buffer) {
    const centered = (sample - 128) / 128;
    sum += centered * centered;
  }
  return Math.min(1, Math.sqrt(sum / Math.max(1, buffer.length)) * 4);
}

export function createAnalyserSpeakingPort(
  options: SpeakingPortOptions = {},
): SpeakingPort {
  const sampleMs = options.sampleMs ?? SPEAKING_SAMPLE_MS;
  const arm =
    options.setInterval ??
    ((fn: () => void, ms: number) => globalThis.setInterval(fn, ms));
  const disarm =
    options.clearInterval ??
    ((handle: unknown) => globalThis.clearInterval(handle as never));
  const listeners = new Set<(event: SpeakingLevelEvent) => void>();
  const observed = new Map<string, Observed>();
  let context: AudioContextLike | null = null;
  let timer: unknown = null;
  let stopped = false;

  function ensureContext(): AudioContextLike | null {
    if (context || stopped) return context;
    const factory =
      options.audioContext ??
      (() => {
        const Ctor = (
          globalThis as unknown as { AudioContext?: new () => AudioContextLike }
        ).AudioContext;
        return Ctor ? new Ctor() : null;
      });
    context = factory();
    return context;
  }

  function sample(): void {
    for (const [peerId, entry] of observed) {
      const level = levelOf(entry.analyser, entry.buffer);
      for (const listener of [...listeners]) listener({ peerId, level });
    }
  }

  return {
    observe(peerId, track) {
      if (stopped || track.kind !== "audio") return () => {};
      const ctx = ensureContext();
      if (!ctx) return () => {};
      let entry: Observed;
      try {
        const analyser = ctx.createAnalyser();
        const stream =
          options.streamFor?.(track) ??
          new MediaStream([track as unknown as MediaStreamTrack]);
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        entry = {
          analyser,
          source,
          buffer: new Uint8Array(analyser.fftSize || 2048),
        };
      } catch {
        // A host that refuses WebAudio simply has no speaking ring. Never a
        // reason to fail a call control.
        return () => {};
      }
      observed.get(peerId)?.source.disconnect();
      observed.set(peerId, entry);
      if (timer === null) timer = arm(sample, sampleMs);
      return () => {
        const current = observed.get(peerId);
        if (current !== entry) return;
        observed.delete(peerId);
        entry.source.disconnect();
        entry.analyser.disconnect();
        if (observed.size === 0 && timer !== null) {
          disarm(timer);
          timer = null;
        }
      };
    },

    onLevel(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    stop() {
      stopped = true;
      if (timer !== null) {
        disarm(timer);
        timer = null;
      }
      for (const entry of observed.values()) {
        entry.source.disconnect();
        entry.analyser.disconnect();
      }
      observed.clear();
      listeners.clear();
      void context?.close().catch(() => {});
      context = null;
    },
  };
}

/**
 * Device enumeration for the pickers. Enumeration is a READ: it lists inputs,
 * it never opens one, so it is safe outside the explicit capture controls.
 * Labels are empty until a permission is granted, and a device with no label
 * is rendered as a neutral ordinal rather than a raw hardware id.
 */
export function browserMediaDevices(): MediaDevicesPort | null {
  const media = globalThis.navigator?.mediaDevices;
  if (!media?.enumerateDevices) return null;
  return {
    async list(): Promise<readonly MediaDeviceOption[]> {
      const devices = await media.enumerateDevices();
      let microphones = 0;
      let cameras = 0;
      const options: MediaDeviceOption[] = [];
      for (const device of devices) {
        if (device.kind !== "audioinput" && device.kind !== "videoinput") {
          continue;
        }
        const microphone = device.kind === "audioinput";
        if (microphone) microphones += 1;
        else cameras += 1;
        options.push({
          deviceId: device.deviceId,
          label:
            device.label ||
            (microphone
              ? `Microphone ${microphones}`
              : `Camera ${cameras}`),
          kind: microphone ? "audioinput" : "videoinput",
        });
      }
      return options;
    },
    onChange(listener) {
      const handler = () => listener();
      media.addEventListener?.("devicechange", handler);
      return () => media.removeEventListener?.("devicechange", handler);
    },
  };
}
