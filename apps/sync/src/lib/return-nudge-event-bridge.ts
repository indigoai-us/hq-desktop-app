import { POST_READY_ACTION_EVENT } from '../../../../packages/platform/src/post-ready-actions.js';

export interface ReturnNudgeEventPayload {
  action: 'start_sync';
  companyUid: string;
  returnNudge: 'shown' | 'clicked' | 'dismissed';
}

export function parseReturnNudgeEventPayload(value: unknown): ReturnNudgeEventPayload | null {
  if (!value || typeof value !== 'object') return null;
  const detail = value as Record<string, unknown>;
  if (
    detail.action !== 'start_sync' ||
    typeof detail.companyUid !== 'string' ||
    !/^cmp_[A-Za-z0-9_-]+$/.test(detail.companyUid) ||
    !['shown', 'clicked', 'dismissed'].includes(String(detail.returnNudge))
  ) return null;

  return {
    action: 'start_sync',
    companyUid: detail.companyUid,
    returnNudge: detail.returnNudge as ReturnNudgeEventPayload['returnNudge'],
  };
}

export function registerDesktopAltReturnNudgeBridge(
  emitToMain: (eventName: string, payload: ReturnNudgeEventPayload) => Promise<void>,
  target: EventTarget = window,
): () => void {
  const forward = (event: Event) => {
    const payload = parseReturnNudgeEventPayload((event as CustomEvent<unknown>).detail);
    if (!payload) return;
    void emitToMain(POST_READY_ACTION_EVENT, payload).catch((error: unknown) => {
      console.warn('desktop-alt: could not forward return-nudge telemetry', {
        errorClass: error instanceof Error ? error.name : 'unknown',
      });
    });
  };
  target.addEventListener(POST_READY_ACTION_EVENT, forward);
  return () => target.removeEventListener(POST_READY_ACTION_EVENT, forward);
}

export function registerMainReturnNudgeListener(
  listen: (handler: (payload: unknown) => void) => Promise<() => void>,
  onReturnNudge: (payload: ReturnNudgeEventPayload) => void,
): Promise<() => void> {
  return listen((value) => {
    const payload = parseReturnNudgeEventPayload(value);
    if (payload) onReturnNudge(payload);
  });
}
