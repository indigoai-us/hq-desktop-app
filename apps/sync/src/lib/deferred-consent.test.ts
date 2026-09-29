import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { TELEMETRY_CONSENT_VERSION } from './consent-version';
import {
  deferredConsentBlocksFinish,
  deferredConsentGate,
  holdConsentAnswer,
  looksOffline,
  sendHeldConsent,
  shouldDeferConsent,
} from './deferred-consent';

function recorder(behaviour: Record<string, () => unknown> = {}) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const invokeCommand = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    const handler = behaviour[command];
    return handler ? handler() : undefined;
  });
  return { calls, invokeCommand };
}

describe('deferred consent: answering before the install finishes', () => {
  it('only defers in the full welcome flow while its install is still running', () => {
    expect(shouldDeferConsent({ consentOnly: false, installPending: true })).toBe(true);
    expect(shouldDeferConsent({ consentOnly: false, installPending: false })).toBe(false);
    // The re-prompt and consent-only runs close on the answer; they never hold it.
    expect(shouldDeferConsent({ consentOnly: true, installPending: true })).toBe(false);
  });

  it('caches the answer with provenance right away and sends nothing yet', async () => {
    const { calls, invokeCommand } = recorder();
    const held = await holdConsentAnswer(false, { invokeCommand });

    expect(held).toEqual({ phase: 'held', enabled: false });
    expect(calls.map((c) => c.command)).toEqual(['write_menubar_telemetry_pref']);
    expect(calls[0]?.args).toEqual({
      enabled: false,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
  });

  it('refuses to hold an answer the machine could not cache', async () => {
    const { calls, invokeCommand } = recorder({
      write_menubar_telemetry_pref: () => {
        throw new Error('disk full');
      },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await holdConsentAnswer(true, { invokeCommand })).toBeNull();
    expect(calls.some((c) => c.command === 'post_telemetry_opt_in')).toBe(false);
  });

  it('confirms the person entity before it posts, and reports a confirmed write as sent', async () => {
    const { calls, invokeCommand } = recorder();
    const sent = await sendHeldConsent({ phase: 'held', enabled: true }, { invokeCommand });

    expect(sent).toEqual({ phase: 'sent', enabled: true });
    expect(calls.map((c) => c.command)).toEqual(['ensure_person_entity', 'post_telemetry_opt_in']);
    expect(calls[1]?.args).toEqual({
      enabled: true,
      surface: 'onboarding',
      consentVersion: TELEMETRY_CONSENT_VERSION,
    });
  });

  it('never reports a failed upload as sent, and tells offline from server failures', async () => {
    const offline = recorder({
      post_telemetry_opt_in: () => {
        throw new Error('error sending request: connection refused (offline)');
      },
    });
    const server = recorder({
      post_telemetry_opt_in: () => {
        throw 'HTTP 500: internal server error';
      },
    });

    const offlineResult = await sendHeldConsent(
      { phase: 'held', enabled: true },
      { invokeCommand: offline.invokeCommand },
    );
    const serverResult = await sendHeldConsent(
      { phase: 'held', enabled: true },
      { invokeCommand: server.invokeCommand },
    );

    expect(offlineResult).toMatchObject({ phase: 'failed', kind: 'offline' });
    expect(serverResult).toMatchObject({ phase: 'failed', kind: 'server' });
    expect(serverResult.phase === 'failed' && serverResult.message).toContain('500');
  });

  it('still posts when the person entity cannot be confirmed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { calls, invokeCommand } = recorder({
      ensure_person_entity: () => {
        throw new Error('no token');
      },
    });
    const result = await sendHeldConsent({ phase: 'held', enabled: false }, { invokeCommand });
    expect(result.phase).toBe('sent');
    expect(calls.map((c) => c.command)).toContain('post_telemetry_opt_in');
  });

  it('holds the finish until the answer is sent, but never traps an offline person', () => {
    expect(deferredConsentBlocksFinish(null)).toBe(false);
    expect(deferredConsentBlocksFinish({ phase: 'held', enabled: true })).toBe(true);
    expect(deferredConsentBlocksFinish({ phase: 'sending', enabled: true })).toBe(true);
    expect(deferredConsentBlocksFinish({ phase: 'sent', enabled: true })).toBe(false);
    expect(
      deferredConsentBlocksFinish({ phase: 'failed', enabled: true, kind: 'offline', message: 'x' }),
    ).toBe(false);
    expect(
      deferredConsentBlocksFinish({ phase: 'failed', enabled: true, kind: 'server', message: 'x' }),
    ).toBe(true);
  });

  it('maps the held answer onto the ready screen gate', () => {
    expect(deferredConsentGate(null)).toBe('clear');
    expect(deferredConsentGate({ phase: 'held', enabled: true })).toBe('pending');
    expect(deferredConsentGate({ phase: 'sending', enabled: true })).toBe('pending');
    expect(deferredConsentGate({ phase: 'sent', enabled: true })).toBe('clear');
    expect(
      deferredConsentGate({ phase: 'failed', enabled: true, kind: 'offline', message: 'x' }),
    ).toBe('clear');
    expect(
      deferredConsentGate({ phase: 'failed', enabled: true, kind: 'server', message: 'x' }),
    ).toBe('blocked');
  });

  it('classifies network-shaped errors as offline', () => {
    expect(looksOffline('ECONNREFUSED')).toBe(true);
    expect(looksOffline('request timed out')).toBe(true);
    expect(looksOffline('HTTP 403: forbidden')).toBe(false);
  });
});
