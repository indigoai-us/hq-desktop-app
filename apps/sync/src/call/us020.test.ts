/**
 * US-020 call-window seams: device selection that never captures on its own,
 * a mute that survives a device change, the moderation policy, and the
 * analyser speaking port's lifetime.
 */

import { describe, expect, it, vi } from "vitest";

import {
  canModerateRole,
  moderationOutcome,
} from "./bootstrap";
import {
  MEDIA_DEVICE_KEY,
  createMediaController,
  type MediaConstraintsLike,
  type MediaStreamLike,
  type PreferenceStorage,
} from "./permissions";
import {
  createAnalyserSpeakingPort,
  type AnalyserLike,
  type AudioContextLike,
} from "./speaking";

function stream(kind: string, id = `${kind}-1`): MediaStreamLike {
  return {
    getTracks: () => [{ id, kind, stop: () => {} }],
  };
}

function memoryStorage(): PreferenceStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

describe("device selection", () => {
  it("remembers a choice without ever opening the device", async () => {
    const getUserMedia = vi.fn(async () => stream("audio"));
    const storage = memoryStorage();
    const media = createMediaController({ getUserMedia, storage });

    await media.selectDevice("microphone", "mic-b");

    // The whole point: picking an input is not a capture. Nothing was opened,
    // so no OS indicator lit and no track exists.
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(media.state().microphone.active).toBe(false);
    expect(media.devices().microphoneId).toBe("mic-b");
    expect(storage.data.get(MEDIA_DEVICE_KEY)).toContain("mic-b");
  });

  it("pins the remembered device on the next explicit enable", async () => {
    const seen: MediaConstraintsLike[] = [];
    const getUserMedia = vi.fn(async (constraints: MediaConstraintsLike) => {
      seen.push(constraints);
      return stream("audio");
    });
    const media = createMediaController({
      getUserMedia,
      storage: memoryStorage(),
    });
    await media.selectDevice("microphone", "mic-b");
    await media.enableMicrophone();
    expect(seen).toEqual([{ audio: { deviceId: { exact: "mic-b" } } }]);
  });

  it("re-opens only a device that is already live", async () => {
    let served = 0;
    const getUserMedia = vi.fn(async () => {
      served += 1;
      return stream("audio", `audio-${served}`);
    });
    const media = createMediaController({
      getUserMedia,
      storage: memoryStorage(),
    });
    await media.enableMicrophone();
    expect(media.tracksFor("microphone").map((track) => track.id)).toEqual([
      "audio-1",
    ]);
    await media.selectDevice("microphone", "mic-b");
    expect(media.tracksFor("microphone").map((track) => track.id)).toEqual([
      "audio-2",
    ]);
    expect(getUserMedia).toHaveBeenCalledTimes(2);

    // Muted, then a device change: the choice lands, the device stays shut.
    media.disableMicrophone();
    await media.selectDevice("microphone", "mic-c");
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(media.state().microphone.active).toBe(false);
    expect(media.devices().microphoneId).toBe("mic-c");
  });

  it("does not lose the device choice when capture is refused", async () => {
    const denial = Object.assign(new Error("no"), { name: "NotAllowedError" });
    const media = createMediaController({
      getUserMedia: async () => {
        throw denial;
      },
      storage: memoryStorage(),
    });
    await media.selectDevice("camera", "cam-b");
    const state = await media.enableCamera();
    expect(state.status).toBe("denied");
    expect(media.devices().cameraId).toBe("cam-b");
  });
});

describe("moderation policy", () => {
  it("honours only a host or cohost, and only to mute", () => {
    expect(canModerateRole("host")).toBe(true);
    expect(canModerateRole("cohost")).toBe(true);
    expect(canModerateRole("participant")).toBe(false);

    expect(moderationOutcome("host", "mute-force")).toBe("mute");
    expect(moderationOutcome("cohost", "mute-force")).toBe("mute");
    expect(moderationOutcome("host", "mute-request")).toBe("notice");
    // A participant has no authority, whatever they send.
    expect(moderationOutcome("participant", "mute-force")).toBe("ignore");
    expect(moderationOutcome("participant", "mute-request")).toBe("ignore");
  });

  it("has no outcome that enables a microphone", () => {
    for (const role of ["host", "cohost", "participant"] as const) {
      for (const action of [
        "unmute",
        "unmute-force",
        "force-unmute",
        "enable",
        "mute-force ",
        "",
      ]) {
        expect(moderationOutcome(role, action)).toBe("ignore");
      }
    }
  });
});

describe("speaking port", () => {
  function fakeAudio(sample: number): {
    context: AudioContextLike;
    disconnects: number;
  } {
    const counter = { disconnects: 0 };
    const analyser: AnalyserLike = {
      fftSize: 8,
      getByteTimeDomainData(array) {
        array.fill(sample);
      },
      disconnect() {
        counter.disconnects += 1;
      },
    };
    return {
      context: {
        createAnalyser: () => analyser,
        createMediaStreamSource: () => ({
          connect: () => {},
          disconnect: () => {
            counter.disconnects += 1;
          },
        }),
        close: async () => {},
      },
      get disconnects() {
        return counter.disconnects;
      },
    };
  }

  it("reports a level per observed audio track and releases its analyser", () => {
    const audio = fakeAudio(200);
    const timer: { tick: (() => void) | null } = { tick: null };
    const port = createAnalyserSpeakingPort({
      audioContext: () => audio.context,
      streamFor: () => ({}),
      setInterval: (fn) => {
        timer.tick = fn;
        return 1;
      },
      clearInterval: () => {
        timer.tick = null;
      },
    });
    const levels: Array<{ peerId: string; level: number }> = [];
    port.onLevel((event) => levels.push(event));
    const off = port.observe("prs_a dev_a", {
      id: "t1",
      kind: "audio",
      stop: () => {},
    });
    timer.tick?.();
    expect(levels).toHaveLength(1);
    expect(levels[0]?.peerId).toBe("prs_a dev_a");
    expect(levels[0]?.level).toBeGreaterThan(0);

    off();
    expect(timer.tick).toBeNull();
    expect(audio.disconnects).toBeGreaterThan(0);
    port.stop();
  });

  it("ignores video tracks and a host with no WebAudio", () => {
    const port = createAnalyserSpeakingPort({ audioContext: () => null });
    const levels: unknown[] = [];
    port.onLevel((event) => levels.push(event));
    port.observe("prs_a dev_a", { id: "v", kind: "video", stop: () => {} })();
    port.observe("prs_a dev_a", { id: "a", kind: "audio", stop: () => {} })();
    expect(levels).toEqual([]);
    port.stop();
  });
});
