/**
 * Explicit media capture for the call window (US-017).
 *
 * The rule this module exists to enforce: `getUserMedia` is called from an
 * explicit join control and from nowhere else. Not on mount, not on a
 * received knock, not on a roster update, not on a remembered preference.
 * Receiving a knock must never light the camera light, so the knock path has
 * no way to reach capture — it does not hold a controller, and the controller
 * has no implicit entry point.
 *
 * Remembered choices are *intent*, never capture: `meet.media.prefs` records
 * "I usually join muted with the camera off" and pre-sets the controls the
 * user then presses. Restoring intent never restores a stream.
 *
 * The tracks live here, not in the session: `MediaPort.localTracks()` reads
 * `tracks()` and the window calls `session.refreshLocalTracks()` after every
 * change, so enabling the microphone mid-call republishes without a rejoin.
 */

import type { TrackLike } from "@hq/meet-core";

export type MediaDeviceKind = "microphone" | "camera";

export type MediaPermissionStatus =
  | "idle"
  | "requesting"
  | "granted"
  | "denied"
  | "error";

export interface MediaDeviceState {
  status: MediaPermissionStatus;
  /** True while a live track for this device is published. */
  active: boolean;
  /** Content-free refusal code. Never a device label or an OS message. */
  code: string | null;
  /** Recovery guidance shown next to a Retry. Null unless denied/errored. */
  recovery: string | null;
}

export interface MediaControllerState {
  microphone: MediaDeviceState;
  camera: MediaDeviceState;
}

/** Remembered *intent*. Never a permission, never a reason to capture. */
export interface MediaPreferences {
  /** True when the user last chose to join with the microphone live. */
  microphone: boolean;
  /** True when the user last chose to join with the camera live. */
  camera: boolean;
}

export const MEDIA_PREFS_KEY = "meet.media.prefs";

/** The structural subset of `MediaStream` the controller needs. */
export interface MediaStreamLike {
  getTracks(): TrackLike[];
}

export type GetUserMediaLike = (constraints: {
  audio?: boolean;
  video?: boolean;
}) => Promise<MediaStreamLike>;

/** The structural subset of `Storage`. Injected so tests touch no globals. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface MediaControllerOptions {
  getUserMedia: GetUserMediaLike;
  storage?: PreferenceStorage | null;
  /** Called after every state transition, with a fresh snapshot. */
  onChange?: (state: MediaControllerState) => void;
}

export interface MediaController {
  state(): MediaControllerState;
  /** The live local tracks. Feeds `MediaPort.localTracks()`. */
  tracks(): TrackLike[];
  /** Remembered intent, for pre-setting the join controls. Never capture. */
  preferences(): MediaPreferences;
  /** Explicit join control. The ONLY path to `getUserMedia` for audio. */
  enableMicrophone(): Promise<MediaDeviceState>;
  /** Explicit join control. The ONLY path to `getUserMedia` for video. */
  enableCamera(): Promise<MediaDeviceState>;
  disableMicrophone(): void;
  disableCamera(): void;
  /** Retry after a denial, from the same explicit control. */
  retry(kind: MediaDeviceKind): Promise<MediaDeviceState>;
  /** Stop every local track. Called on leave, dispose and account change. */
  stopAll(reason?: string): void;
}

/** OS-level recovery paths. Copy only — this module cannot open Settings. */
const RECOVERY: Record<MediaDeviceKind, string> = {
  microphone:
    "Allow microphone access for HQ in System Settings › Privacy & Security › Microphone, then try again.",
  camera:
    "Allow camera access for HQ in System Settings › Privacy & Security › Camera, then try again.",
};

const DENIAL_NAMES = new Set([
  "NotAllowedError",
  "PermissionDeniedError",
  "SecurityError",
]);

function idle(): MediaDeviceState {
  return { status: "idle", active: false, code: null, recovery: null };
}

function isDenial(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && DENIAL_NAMES.has(name);
}

/**
 * Refusal codes are derived from the error *name* only. The message can carry
 * a device label (and on some platforms a path), and nothing user- or
 * device-identifying may reach the view model or a snapshot.
 */
function codeOf(error: unknown): string {
  const name = (error as { name?: unknown } | null)?.name;
  if (typeof name !== "string" || !/^[A-Za-z]+$/.test(name)) {
    return "MEDIA_UNAVAILABLE";
  }
  return name === "NotFoundError" ? "MEDIA_DEVICE_MISSING" : name;
}

function readPreferences(storage: PreferenceStorage | null): MediaPreferences {
  if (!storage) return { microphone: false, camera: false };
  try {
    const raw = storage.getItem(MEDIA_PREFS_KEY);
    if (!raw) return { microphone: false, camera: false };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { microphone: false, camera: false };
    }
    const record = parsed as Record<string, unknown>;
    return {
      microphone: record.microphone === true,
      camera: record.camera === true,
    };
  } catch {
    // Corrupt or unavailable storage falls back to the safest intent: off.
    return { microphone: false, camera: false };
  }
}

export function createMediaController(
  options: MediaControllerOptions,
): MediaController {
  const storage = options.storage ?? null;
  const state: MediaControllerState = { microphone: idle(), camera: idle() };
  const live = new Map<MediaDeviceKind, TrackLike[]>();
  let preferences = readPreferences(storage);

  function publish(): void {
    options.onChange?.({
      microphone: { ...state.microphone },
      camera: { ...state.camera },
    });
  }

  function remember(kind: MediaDeviceKind, value: boolean): void {
    preferences = { ...preferences, [kind]: value };
    if (!storage) return;
    try {
      // Intent only. No device ids, no permission state, no identity.
      storage.setItem(MEDIA_PREFS_KEY, JSON.stringify(preferences));
    } catch {
      // A full or blocked store must never break a call control.
    }
  }

  function stop(kind: MediaDeviceKind): void {
    for (const track of live.get(kind) ?? []) {
      try {
        track.stop();
      } catch {
        // A track that is already ended throws on some hosts; ignore.
      }
    }
    live.delete(kind);
  }

  async function enable(kind: MediaDeviceKind): Promise<MediaDeviceState> {
    if (state[kind].status === "requesting") return { ...state[kind] };
    if (state[kind].active) return { ...state[kind] };

    state[kind] = { status: "requesting", active: false, code: null, recovery: null };
    publish();

    try {
      const stream = await options.getUserMedia(
        kind === "microphone" ? { audio: true } : { video: true },
      );
      const tracks = stream
        .getTracks()
        .filter((track) =>
          kind === "microphone" ? track.kind === "audio" : track.kind === "video",
        );
      if (tracks.length === 0) {
        state[kind] = {
          status: "error",
          active: false,
          code: "MEDIA_DEVICE_MISSING",
          recovery: RECOVERY[kind],
        };
        publish();
        return { ...state[kind] };
      }
      stop(kind);
      live.set(kind, tracks);
      state[kind] = { status: "granted", active: true, code: null, recovery: null };
      remember(kind, true);
      publish();
      return { ...state[kind] };
    } catch (error) {
      const denied = isDenial(error);
      state[kind] = {
        status: denied ? "denied" : "error",
        active: false,
        code: denied ? "MEDIA_PERMISSION_DENIED" : codeOf(error),
        recovery: RECOVERY[kind],
      };
      publish();
      return { ...state[kind] };
    }
  }

  function disable(kind: MediaDeviceKind): void {
    stop(kind);
    state[kind] = idle();
    remember(kind, false);
    publish();
  }

  return {
    state: () => ({
      microphone: { ...state.microphone },
      camera: { ...state.camera },
    }),
    tracks: () => [...live.values()].flat(),
    preferences: () => ({ ...preferences }),
    enableMicrophone: () => enable("microphone"),
    enableCamera: () => enable("camera"),
    disableMicrophone: () => disable("microphone"),
    disableCamera: () => disable("camera"),
    retry: (kind) => enable(kind),

    stopAll(): void {
      for (const kind of ["microphone", "camera"] as const) {
        stop(kind);
        // The remembered intent survives: the user's choice is not revoked by
        // the call ending, an account change, or a permission loss.
        state[kind] = idle();
      }
      publish();
    },
  };
}

/** The browser `getUserMedia`, narrowed. Absent outside a webview. */
export function browserGetUserMedia(): GetUserMediaLike {
  return async (constraints) => {
    const media = globalThis.navigator?.mediaDevices;
    if (!media?.getUserMedia) {
      const error = new Error("Media capture is unavailable on this host.");
      error.name = "NotSupportedError";
      throw error;
    }
    return (await media.getUserMedia(
      constraints as MediaStreamConstraints,
    )) as unknown as MediaStreamLike;
  };
}

/** `localStorage`, or null where it is blocked (private mode, no window). */
export function windowPreferenceStorage(): PreferenceStorage | null {
  try {
    const store = globalThis.localStorage;
    if (!store) return null;
    return {
      getItem: (key) => store.getItem(key),
      setItem: (key, value) => store.setItem(key, value),
    };
  } catch {
    return null;
  }
}
