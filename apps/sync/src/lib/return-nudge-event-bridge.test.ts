import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { POST_READY_ACTION_EVENT } from '../../../../packages/platform/src/post-ready-actions.js';
import {
  parseReturnNudgeEventPayload,
  registerDesktopAltReturnNudgeBridge,
  registerMainReturnNudgeListener,
} from './return-nudge-event-bridge';

describe('return nudge cross-window event bridge', () => {
  it('forwards only bounded nudge fields from desktop-alt to main', async () => {
    const emitToMain = vi.fn(async () => {});
    const target = new EventTarget();
    const unregister = registerDesktopAltReturnNudgeBridge(emitToMain, target);
    const event = Object.assign(new Event(POST_READY_ACTION_EVENT), {
      detail: {
        action: 'start_sync',
        companyUid: 'cmp_company',
        returnNudge: 'shown',
        extra: 'discard this field',
      },
    });
    target.dispatchEvent(event);

    await vi.waitFor(() => expect(emitToMain).toHaveBeenCalledOnce());
    expect(emitToMain).toHaveBeenCalledWith(POST_READY_ACTION_EVENT, {
      action: 'start_sync',
      companyUid: 'cmp_company',
      returnNudge: 'shown',
    });
    unregister();
  });

  it('rejects unbounded values before they cross the webview boundary', () => {
    expect(parseReturnNudgeEventPayload({
      action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'shown', email: 'person@example.test',
    })).toEqual({ action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'shown' });
    expect(parseReturnNudgeEventPayload({
      action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'email_sent',
    })).toBeNull();
    expect(parseReturnNudgeEventPayload({
      action: 'start_sync', companyUid: 'not-a-company', returnNudge: 'shown',
    })).toBeNull();
  });

  it('passes the Tauri payload received by main to its existing DOM event handler', async () => {
    let onEvent: ((payload: unknown) => void) | undefined;
    const unlisten = vi.fn();
    const received = vi.fn();
    await registerMainReturnNudgeListener(async (handler) => {
      onEvent = handler;
      return unlisten;
    }, received);

    onEvent?.({ action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'dismissed' });
    onEvent?.({ action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'arbitrary' });
    expect(received).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledWith({
      action: 'start_sync', companyUid: 'cmp_company', returnNudge: 'dismissed',
    });
  });

  it('keeps both webviews connected to the shared post-ready event name', () => {
    const app = readFileSync(fileURLToPath(new URL('../App.svelte', import.meta.url)), 'utf8');
    const desktopAlt = readFileSync(fileURLToPath(new URL('../desktop-alt/main.ts', import.meta.url)), 'utf8');
    expect(app).toMatch(/const unlistenReturnNudge = registerMainReturnNudgeListener\(/);
    expect(desktopAlt).toMatch(/registerDesktopAltReturnNudgeBridge\(\(eventName, payload\)/);
    expect(desktopAlt).toContain("emitTo('main', eventName, payload)");
  });
});
