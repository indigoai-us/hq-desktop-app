import { getCurrentWindow } from '@tauri-apps/api/window';
import { emitDesktopOperationalTelemetry } from './desktop-telemetry';
import {
  POST_READY_ACTIONS,
  POST_READY_ACTION_EVENT,
  type PostReadyAction,
} from '../../../../packages/platform/src/post-ready-actions.js';

export {
  POST_READY_ACTIONS,
  POST_READY_ACTION_EVENT,
} from '../../../../packages/platform/src/post-ready-actions.js';
export type { PostReadyAction } from '../../../../packages/platform/src/post-ready-actions.js';

const STORAGE_KEY = 'hq:desktop-post-ready-action:v1';

export interface PostReadyActionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PostReadyActionEvent {
  eventName: 'desktop_post_ready_action';
  sessionId: string;
  idempotencyKey: string;
  companyUid: string;
  properties: {
    action: PostReadyAction;
    personUid: string;
    companyUid: string;
    appVersion: string;
    os: 'macos' | 'windows' | 'linux';
    returnNudge?: 'shown' | 'clicked' | 'dismissed';
  };
}

export const POST_READY_ACTION_DROP_REASONS = [
  'not_ready',
  'already_sent',
  'flag_off',
  'flag_error',
  'identity_error',
  'identity_missing',
] as const;
export type PostReadyActionDropReason = (typeof POST_READY_ACTION_DROP_REASONS)[number];

export interface PostReadyActionDroppedEvent {
  eventName: 'desktop_post_ready_action_dropped';
  sessionId?: string;
  properties: {
    reason: PostReadyActionDropReason;
    action: PostReadyAction;
  };
}

type PostReadyTelemetryEvent = PostReadyActionEvent | PostReadyActionDroppedEvent;

export interface PostReadyActionTelemetryOptions {
  storage?: PostReadyActionStorage | null;
  isFlagEnabled: () => Promise<boolean>;
  isDropReasonFlagEnabled: () => Promise<boolean>;
  getIdentity: (
    scope?: { companyUid?: string; companySlug?: string },
  ) => Promise<{ personUid: string; companyUid: string | null } | null>;
  appVersion: string;
  os: 'macos' | 'windows' | 'linux';
  emit?: (event: PostReadyTelemetryEvent) => Promise<void>;
  newSessionId?: () => string;
}

interface StoredState {
  version: 1;
  ready: boolean;
  sessionId: string | null;
  sent: PostReadyAction[];
  ended: boolean;
  dropReasonSent: boolean;
}

export interface PostReadyActionTelemetry {
  record(
    action: PostReadyAction,
    scope?: { companyUid?: string; companySlug?: string },
  ): Promise<boolean>;
  recordReturnNudge(
    value: 'shown' | 'clicked' | 'dismissed',
    scope: { companyUid: string },
  ): Promise<boolean>;
}

export function registerPostReadyCloseTelemetry(
  telemetry: Promise<PostReadyActionTelemetry>,
) {
  return getCurrentWindow().onCloseRequested((event) => {
    // Rust owns hide-on-close for the main window; prevent Tauri's default destroy.
    event.preventDefault();
    void telemetry.then((actions) => actions.record('close_window'));
  });
}

export function markPostReadyActionReady(
  storage: PostReadyActionStorage | null = safeStorage(),
): void {
  const state = loadState(storage);
  if (state.ended) return;
  saveState(storage, { ...state, ready: true });
}

/** Read the same persisted ready marker used to admit post-ready telemetry. */
export function isPostReadyActionReady(
  storage: PostReadyActionStorage | null = safeStorage(),
): boolean {
  return loadState(storage).ready;
}

export function createPostReadyActionTelemetry(
  options: PostReadyActionTelemetryOptions,
): PostReadyActionTelemetry {
  const storage = options.storage === undefined ? safeStorage() : options.storage;
  const emit = options.emit ?? ((event) =>
    event.eventName === 'desktop_post_ready_action_dropped'
      ? emitDesktopOperationalTelemetry({
          eventName: event.eventName,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
          properties: event.properties,
        })
      : emitDesktopOperationalTelemetry({
          eventName: event.eventName,
          sessionId: event.sessionId,
          properties: { ...event.properties, idempotencyKey: event.idempotencyKey },
        })
  );
  const newSessionId = options.newSessionId ?? createUuid;
  let state = loadState(storage);
  let operation = Promise.resolve(false);
  let dropReasonPending: Promise<void> | null = null;

  async function reportDropReason(action: PostReadyAction, reason: PostReadyActionDropReason): Promise<void> {
    if (state.dropReasonSent) return;
    if (dropReasonPending) {
      await dropReasonPending;
      return;
    }
    dropReasonPending = (async () => {
      let enabled = false;
      try {
        enabled = await options.isDropReasonFlagEnabled();
      } catch (err) {
        console.warn('[post-ready telemetry] drop-reason flag lookup failed:', err);
        return;
      }
      if (!enabled || state.dropReasonSent) return;
      state = { ...state, dropReasonSent: true };
      saveState(storage, state);
      try {
        await emit({
          eventName: 'desktop_post_ready_action_dropped',
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          properties: { reason, action },
        });
      } catch (err) {
        console.warn('[post-ready telemetry] drop-reason event delivery failed:', err);
      }
    })();
    try {
      await dropReasonPending;
    } finally {
      dropReasonPending = null;
    }
  }

  function beginFirstSessionIfReady(allowClosedSession = false): boolean {
    if (!state.ready || (state.ended && !allowClosedSession)) return false;
    if (!state.sessionId) {
      state = { ...state, sessionId: newSessionId() };
      saveState(storage, state);
    }
    return true;
  }

  async function record(
    action: PostReadyAction,
    scope?: { companyUid?: string; companySlug?: string },
  ): Promise<boolean> {
    // The app-shell adapter is created before the welcome flow reaches `ready`.
    // Refresh the persisted marker when a later UI action arrives.
    state = loadState(storage);
    if (!POST_READY_ACTIONS.includes(action)) {
      return false;
    }
    if (!state.ready) {
      await reportDropReason(action, 'not_ready');
      return false;
    }
    if (state.ended || state.sent.includes(action)) {
      await reportDropReason(action, 'already_sent');
      return false;
    }
    beginFirstSessionIfReady(action === 'close_window');
    if (action === 'close_window') {
      // End the measured first session even if telemetry is disabled or offline.
      state = { ...state, ended: true };
      saveState(storage, state);
    }

    const pending = operation.then(async () => {
      if (
        state.sent.includes(action) || (state.ended && action !== 'close_window')
      ) {
        await reportDropReason(action, 'already_sent');
        return false;
      }
      let enabled = false;
      try {
        enabled = await options.isFlagEnabled();
      } catch (err) {
        console.warn('[post-ready telemetry] flag lookup failed:', err);
        await reportDropReason(action, 'flag_error');
        return false;
      }
      if (!enabled) {
        await reportDropReason(action, 'flag_off');
        return false;
      }

      let identity: Awaited<ReturnType<typeof options.getIdentity>>;
      try {
        identity = await options.getIdentity(scope);
      } catch (err) {
        console.warn('[post-ready telemetry] identity lookup failed:', err);
        await reportDropReason(action, 'identity_error');
        return false;
      }
      const personUid = identity?.personUid.trim() ?? '';
      const companyUid = identity?.companyUid?.trim() ?? '';
      if (!/^prs_[A-Za-z0-9_-]+$/.test(personUid) || !/^cmp_[A-Za-z0-9_-]+$/.test(companyUid)) {
        await reportDropReason(action, 'identity_missing');
        return false;
      }

      const sessionId = state.sessionId!;
      // Named measurement question: which people who reached `ready` take a
      // first real desktop action during that first session?
      const event: PostReadyActionEvent = {
        eventName: 'desktop_post_ready_action',
        sessionId,
        idempotencyKey: `post-ready.${sessionId}.${action}`,
        companyUid,
        properties: {
          action,
          personUid,
          companyUid,
          appVersion: options.appVersion.trim() || 'unknown',
          os: options.os,
        },
      };
      state = { ...state, sent: [...state.sent, action], ended: action === 'close_window' };
      saveState(storage, state);
      try {
        await emit(event);
      } catch (err) {
        console.warn('[post-ready telemetry] event delivery failed:', err);
        // A stable idempotency key makes a later retry safe if delivery failed.
        state = {
          ...state,
          sent: state.sent.filter((sentAction) => sentAction !== action),
          ended: action === 'close_window' || state.ended,
        };
        saveState(storage, state);
        return false;
      }
      return true;
    });
    operation = pending.then(
      () => false,
      (err) => {
        console.warn('[post-ready telemetry] action processing failed:', err);
        return false;
      },
    );
    return pending;
  }

  async function recordReturnNudge(
    value: 'shown' | 'clicked' | 'dismissed',
    scope: { companyUid: string },
  ): Promise<boolean> {
    state = loadState(storage);
    if (!['shown', 'clicked', 'dismissed'].includes(value) || !beginFirstSessionIfReady(true)) return false;
    const pending = operation.then(async () => {
      if (!beginFirstSessionIfReady(true)) return false;
      let enabled = false;
      try {
        enabled = await options.isFlagEnabled();
      } catch (err) {
        console.warn('[post-ready telemetry] flag lookup failed:', err);
        return false;
      }
      if (!enabled) return false;
      let identity: Awaited<ReturnType<typeof options.getIdentity>>;
      try {
        identity = await options.getIdentity(scope);
      } catch (err) {
        console.warn('[post-ready telemetry] identity lookup failed:', err);
        return false;
      }
      const personUid = identity?.personUid.trim() ?? '';
      const companyUid = identity?.companyUid?.trim() ?? '';
      if (!/^prs_[A-Za-z0-9_-]+$/.test(personUid) || companyUid !== scope.companyUid || !/^cmp_[A-Za-z0-9_-]+$/.test(companyUid)) return false;
      const sessionId = state.sessionId;
      if (!sessionId) return false;
      const utcDay = new Date().toISOString().slice(0, 10);
      try {
        await emit({
          eventName: 'desktop_post_ready_action',
          sessionId,
          idempotencyKey: `post-ready.${sessionId}.return-nudge.${companyUid}.${utcDay}.${value}`,
          companyUid,
          properties: {
            action: 'start_sync',
            personUid,
            companyUid,
            appVersion: options.appVersion.trim() || 'unknown',
            os: options.os,
            returnNudge: value,
          },
        });
        return true;
      } catch (err) {
        console.warn('[post-ready telemetry] return nudge delivery failed:', err);
        return false;
      }
    });
    operation = pending.then(() => false, (err) => {
      console.warn('[post-ready telemetry] return nudge processing failed:', err);
      return false;
    });
    return pending;
  }

  return { record, recordReturnNudge };
}

export function isPostReadyAction(value: unknown): value is PostReadyAction {
  return typeof value === 'string' && (POST_READY_ACTIONS as readonly string[]).includes(value);
}

function loadState(storage: PostReadyActionStorage | null): StoredState {
  const empty: StoredState = {
    version: 1,
    ready: false,
    sessionId: null,
    sent: [],
    ended: false,
    dropReasonSent: false,
  };
  if (!storage) return empty;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    if (parsed.version !== 1 || typeof parsed.ready !== 'boolean') return empty;
    return {
      version: 1,
      ready: parsed.ready,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
      sent: Array.isArray(parsed.sent) ? parsed.sent.filter(isPostReadyAction) : [],
      ended: parsed.ended === true,
      dropReasonSent: parsed.dropReasonSent === true,
    };
  } catch (err) {
    console.warn('[post-ready telemetry] local state read failed:', err);
    return empty;
  }
}

function saveState(storage: PostReadyActionStorage | null, state: StoredState): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // Telemetry state is best-effort and cannot interrupt the desktop action.
    console.warn('[post-ready telemetry] local state write failed:', err);
  }
}

function safeStorage(): PostReadyActionStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch (err) {
    console.warn('[post-ready telemetry] local storage unavailable:', err);
    return null;
  }
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    return (token === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}
