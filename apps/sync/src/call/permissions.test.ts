/**
 * US-017 — explicit media capture.
 *
 * The load-bearing assertion in this file is negative: nothing except an
 * explicit enable/retry call ever reaches `getUserMedia`. Constructing the
 * controller, reading remembered preferences and receiving a knock all leave
 * the call count at zero.
 */

import { describe, expect, it, vi } from "vitest";

import {
  MEDIA_PREFS_KEY,
  createMediaController,
  type MediaConstraintsLike,
  type GetUserMediaLike,
  type MediaStreamLike,
  type PreferenceStorage,
} from "./permissions";

function track(kind: string, id = `${kind}-1`) {
  return { id, kind, stop: vi.fn() };
}

function stream(...kinds: string[]): MediaStreamLike {
  const tracks = kinds.map((kind) => track(kind));
  return { getTracks: () => tracks };
}

function memoryStorage(seed: Record<string, string> = {}): PreferenceStorage & {
  data: Record<string, string>;
} {
  const data = { ...seed };
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value;
    },
  };
}

function controller(
  getUserMedia: GetUserMediaLike = vi.fn(async () => stream("audio")),
  storage: PreferenceStorage | null = memoryStorage(),
) {
  const states: unknown[] = [];
  const media = createMediaController({
    getUserMedia,
    storage,
    onChange: (state) => states.push(state),
  });
  return { media, states, getUserMedia };
}

describe("media controller", () => {
  it("starts idle and captures nothing on construction", () => {
    const getUserMedia = vi.fn(async () => stream("audio"));
    const { media } = controller(getUserMedia);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(media.state().microphone.status).toBe("idle");
    expect(media.state().camera.status).toBe("idle");
    expect(media.tracks()).toEqual([]);
  });

  it("never captures from a remembered preference — intent only", () => {
    const getUserMedia = vi.fn(async () => stream("audio"));
    const storage = memoryStorage({
      [MEDIA_PREFS_KEY]: JSON.stringify({ microphone: true, camera: true }),
    });
    const { media } = controller(getUserMedia, storage);
    expect(media.preferences()).toEqual({ microphone: true, camera: true });
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(media.tracks()).toEqual([]);
  });

  it("captures only from the explicit enable control", async () => {
    const getUserMedia = vi.fn(async () => stream("audio"));
    const { media } = controller(getUserMedia);
    const state = await media.enableMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(state).toEqual({
      status: "granted",
      active: true,
      code: null,
      recovery: null,
    });
    expect(media.tracks().map((entry) => entry.kind)).toEqual(["audio"]);
  });

  it("asks for audio and video separately, never together", async () => {
    const getUserMedia = vi.fn(async (constraints: MediaConstraintsLike) =>
      constraints.video ? stream("video") : stream("audio"),
    );
    const { media } = controller(getUserMedia);
    await media.enableMicrophone();
    await media.enableCamera();
    expect(getUserMedia.mock.calls.map(([c]) => c)).toEqual([
      { audio: true },
      { video: true },
    ]);
    expect(media.tracks().map((entry) => entry.kind).sort()).toEqual([
      "audio",
      "video",
    ]);
  });

  it("surfaces a denial with recovery guidance and a working retry", async () => {
    const denial = Object.assign(new Error("denied"), {
      name: "NotAllowedError",
    });
    let fail = true;
    const getUserMedia = vi.fn(async () => {
      if (fail) throw denial;
      return stream("video");
    });
    const { media } = controller(getUserMedia);

    const denied = await media.enableCamera();
    expect(denied.status).toBe("denied");
    expect(denied.code).toBe("MEDIA_PERMISSION_DENIED");
    expect(denied.recovery).toContain("System Settings");
    expect(media.tracks()).toEqual([]);

    fail = false;
    const granted = await media.retry("camera");
    expect(granted.status).toBe("granted");
    expect(media.tracks()).toHaveLength(1);
  });

  it("keeps the failure code content-free", async () => {
    const error = Object.assign(
      new Error("Requested device not found: 'Stefan's MacBook Microphone'"),
      { name: "NotFoundError" },
    );
    const { media } = controller(
      vi.fn(async () => {
        throw error;
      }),
    );
    const state = await media.enableMicrophone();
    expect(state.status).toBe("error");
    expect(state.code).toBe("MEDIA_DEVICE_MISSING");
    expect(JSON.stringify(media.state())).not.toContain("Stefan");
  });

  it("errors rather than publishing when the stream has no matching track", async () => {
    const { media } = controller(vi.fn(async () => stream("video")));
    const state = await media.enableMicrophone();
    expect(state.status).toBe("error");
    expect(state.code).toBe("MEDIA_DEVICE_MISSING");
    expect(media.tracks()).toEqual([]);
  });

  it("remembers intentional mute and camera-off choices", async () => {
    const storage = memoryStorage();
    const { media } = controller(
      vi.fn(async () => stream("audio")),
      storage,
    );
    await media.enableMicrophone();
    expect(JSON.parse(storage.data[MEDIA_PREFS_KEY]!)).toEqual({
      microphone: true,
      camera: false,
    });
    media.disableMicrophone();
    expect(JSON.parse(storage.data[MEDIA_PREFS_KEY]!)).toEqual({
      microphone: false,
      camera: false,
    });
    expect(media.preferences()).toEqual({ microphone: false, camera: false });
  });

  it("stores no permission state, device id or identity in preferences", async () => {
    const storage = memoryStorage();
    const { media } = controller(
      vi.fn(async () => ({
        getTracks: () => [track("audio", "device-secret-id")],
      })),
      storage,
    );
    await media.enableMicrophone();
    expect(storage.data[MEDIA_PREFS_KEY]).toBe(
      '{"microphone":true,"camera":false}',
    );
  });

  it("stops the track on disable and on stopAll", async () => {
    const audio = track("audio");
    const { media } = controller(
      vi.fn(async () => ({ getTracks: () => [audio] })),
    );
    await media.enableMicrophone();
    media.disableMicrophone();
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(media.tracks()).toEqual([]);

    const video = track("video");
    const second = createMediaController({
      getUserMedia: async () => ({ getTracks: () => [video] }),
      storage: null,
    });
    await second.enableCamera();
    second.stopAll("account-changed");
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(second.tracks()).toEqual([]);
    expect(second.state().camera.status).toBe("idle");
  });

  it("does not re-request while a request is already in flight", async () => {
    let resolve: ((value: MediaStreamLike) => void) | undefined;
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStreamLike>((r) => {
          resolve = r;
        }),
    );
    const { media } = controller(getUserMedia);
    const first = media.enableMicrophone();
    await media.enableMicrophone();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    resolve?.(stream("audio"));
    await first;
  });

  it("survives storage that throws", async () => {
    const hostile: PreferenceStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const { media } = controller(vi.fn(async () => stream("audio")), hostile);
    expect(media.preferences()).toEqual({ microphone: false, camera: false });
    await expect(media.enableMicrophone()).resolves.toMatchObject({
      status: "granted",
    });
  });
});


describe("capture cancellation", () => {
  it.each(["microphone", "camera"] as const)("discards a late %s after stopAll", async kind => {
    let resolve!: (value: MediaStreamLike) => void;
    const { media } = controller(() => new Promise(r => { resolve = r; }));
    const pending = kind === "microphone" ? media.enableMicrophone() : media.enableCamera();
    media.stopAll("account-changed");
    const late = track(kind === "microphone" ? "audio" : "video");
    resolve({ getTracks: () => [late] });
    expect((await pending).active).toBe(false);
    expect(late.stop).toHaveBeenCalledOnce();
    expect(media.tracks()).toEqual([]);
    expect(media.state()[kind].active).toBe(false);
  });

  it("does not let a canceled capture replace a newer explicit capture", async () => {
    const resolves: Array<(value: MediaStreamLike) => void> = [];
    const { media } = controller(() => new Promise(r => { resolves.push(r); }));
    const old = media.enableMicrophone();
    media.disableMicrophone();
    const current = media.enableMicrophone();
    const fresh = track("audio", "fresh"), obsolete = track("audio", "obsolete");
    resolves[1]({ getTracks: () => [fresh] });
    await current;
    resolves[0]({ getTracks: () => [obsolete] });
    expect((await old).active).toBe(false);
    expect(obsolete.stop).toHaveBeenCalledOnce();
    expect(fresh.stop).not.toHaveBeenCalled();
    expect(media.tracks()).toEqual([fresh]);
  });

  it("ignores an obsolete rejection after a newer request succeeds", async () => {
    let reject!: (error: Error) => void;
    let first = true;
    const fresh = track("audio");
    const { media } = controller(() => {
      if (first) { first = false; return new Promise((_resolve, r) => { reject = r; }); }
      return Promise.resolve({ getTracks: () => [fresh] });
    });
    const old = media.enableMicrophone();
    media.disableMicrophone();
    await media.enableMicrophone();
    reject(new Error("old request failed"));
    await old;
    expect(media.state().microphone.active).toBe(true);
    expect(media.tracks()).toEqual([fresh]);
  });
});
