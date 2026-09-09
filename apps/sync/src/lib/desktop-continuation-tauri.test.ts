import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyDelivery,
  continuationDeps,
  loadContinuationContext,
  type ContinuationContext,
  type ContinuationTauriOptions,
  type InvokeFn,
} from './desktop-continuation-tauri';

const CONTEXT: ContinuationContext = {
  installAttemptId: '11111111-1111-4111-8111-111111111111',
  appVersion: '1.4.2',
  apiBase: 'http://127.0.0.1:1',
};

/**
 * The bundle every dependency test starts from.
 *
 * `invoke` is annotated rather than inferred: without it TypeScript pins the
 * helper's return type to `Promise<undefined>` from the default stub, and every
 * test that swaps in a stub returning a status fails to typecheck.
 */
function options(
  overrides: Record<string, unknown> = {},
): ContinuationTauriOptions & { invoke: InvokeFn; platform: 'mac' } {
  return {
    invoke: vi.fn(async () => undefined) as InvokeFn,
    storage: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
    now: () => 1_800_000_000_000,
    newId: () => 'id-1',
    platform: 'mac' as const,
    ...overrides,
  };
}

describe('loading the native context', () => {
  it('passes a well-formed context through, trimming the base', async () => {
    const invoke = vi.fn(async () => ({ ...CONTEXT, apiBase: 'http://127.0.0.1:1///' }));
    await expect(loadContinuationContext(options({ invoke }))).resolves.toEqual(CONTEXT);
  });

  it('is null when the native side has no stable installation id', async () => {
    const invoke = vi.fn(async () => null);
    await expect(loadContinuationContext(options({ invoke }))).resolves.toBeNull();
  });

  it('is null when the command is not registered in this build', async () => {
    // An older shell, or a build where the command was removed. Continuation
    // must not throw into whatever called it — it must simply not run.
    const invoke = vi.fn(async () => {
      throw new Error('command desktop_continuation_context not found');
    });
    await expect(loadContinuationContext(options({ invoke }))).resolves.toBeNull();
  });

  it.each([
    ['a blank installation id', { ...CONTEXT, installAttemptId: '   ' }],
    ['a missing installation id', { ...CONTEXT, installAttemptId: undefined }],
    ['a blank api base', { ...CONTEXT, apiBase: '' }],
    ['a non-string version', { ...CONTEXT, appVersion: 142 }],
  ])('refuses %s rather than half-using it', async (_label, body) => {
    const invoke = vi.fn(async () => body);
    await expect(loadContinuationContext(options({ invoke }))).resolves.toBeNull();
  });
});

describe('delivery classification', () => {
  it('records a 2xx', () => {
    for (const status of [200, 201, 204]) {
      expect(classifyDelivery(status)).toBe('recorded');
    }
  });

  it('retries a 5xx and a throttle, so nothing is lost to a bad ten minutes', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyDelivery(status)).toBe('retry');
    }
  });

  it('drops a 4xx instead of retrying it forever', () => {
    // A 400 means this build is sending something the backend will never
    // accept. Retrying would fill the queue and change nothing.
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(classifyDelivery(status)).toBe('rejected');
    }
  });
});

describe('the dependency bundle', () => {
  let opts: ReturnType<typeof options>;

  beforeEach(() => {
    opts = options();
  });

  it('asks the native side for the config and never the network', async () => {
    // The webview has no HTTP permission in the expanded desktop window, so a
    // fetch from here is denied there and continuation can never run on the
    // surface `hq-desktop://signin` opens. This is the regression: the config
    // read has to go over the bridge.
    opts.invoke = vi.fn(async () => ({ protocolVersion: 1 }));
    const deps = continuationDeps(CONTEXT, opts);
    await expect(deps.fetchConfig()).resolves.toEqual({ protocolVersion: 1 });
    expect(opts.invoke).toHaveBeenCalledWith('desktop_continuation_config');
  });

  it('treats a refused config as no config at all', async () => {
    // A captive portal answering 200 with HTML, a 404, an unreachable host —
    // the native side turns all of them into an error, and an error is not a
    // document to act on.
    opts.invoke = vi.fn(async () => {
      throw new Error('CONTINUATION_CONFIG_STATUS_404');
    });
    const deps = continuationDeps(CONTEXT, opts);
    await expect(deps.fetchConfig()).rejects.toThrow();
  });

  it('keeps a receipt queued when the network is gone', async () => {
    opts.invoke = vi.fn(async () => {
      throw new Error('CONTINUATION_OFFLINE');
    });
    const deps = continuationDeps(CONTEXT, opts);
    await expect(
      deps.deliver({ path: '/v1/desktop/onboarding/launch', body: { eventId: 'e1' } }),
    ).resolves.toBe('retry');
  });

  it('hands the receipt to the native side verbatim, path and all', async () => {
    opts.invoke = vi.fn(async () => 202);
    const deps = continuationDeps(CONTEXT, opts);
    const receipt = {
      path: '/v1/desktop/onboarding/progress',
      body: { eventId: 'e1', occurredAt: '2026-09-09T00:00:00.000Z', outcome: 'started' },
    };
    await expect(deps.deliver(receipt)).resolves.toBe('recorded');
    expect(opts.invoke).toHaveBeenCalledWith('desktop_continuation_deliver', {
      path: receipt.path,
      body: receipt.body,
    });
  });

  it('sends nothing that could identify anyone across the bridge', async () => {
    // These routes are called before anyone is signed in. The renderer holds no
    // credential and must pass none: the payload is the receipt and the path,
    // and nothing else rides along.
    opts.invoke = vi.fn(async () => 200);
    const deps = continuationDeps(CONTEXT, opts);
    await deps.deliver({ path: '/v1/desktop/onboarding/launch', body: { eventId: 'e1' } });
    const call = (opts.invoke as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    expect(Object.keys(call[1] as Record<string, unknown>).sort()).toEqual(['body', 'path']);
  });

  it('classifies what the native side reports rather than assuming success', async () => {
    opts.invoke = vi.fn(async () => 500);
    const deps = continuationDeps(CONTEXT, opts);
    await expect(
      deps.deliver({ path: '/v1/desktop/onboarding/launch', body: { eventId: 'e1' } }),
    ).resolves.toBe('retry');

    opts.invoke = vi.fn(async () => 400);
    await expect(
      continuationDeps(CONTEXT, opts).deliver({
        path: '/v1/desktop/onboarding/launch',
        body: { eventId: 'e1' },
      }),
    ).resolves.toBe('rejected');
  });
});

describe('the native bridge', () => {
  it('starts an attempt without handing the renderer anything to hold', async () => {
    const invoke = vi.fn(async () => ({ attemptId: 'attempt-1' }));
    const deps = continuationDeps(CONTEXT, options({ invoke }));
    await deps.bridge.start({ installAttemptId: CONTEXT.installAttemptId, sessionId: 's1' });
    // One argument, no payload: no state, no verifier, no nonce crosses here.
    expect(invoke).toHaveBeenCalledWith('desktop_continuation_start');
  });

  it('confirms and cancels by attempt id and nothing else', async () => {
    const invoke = vi.fn(async () => undefined);
    const deps = continuationDeps(CONTEXT, options({ invoke }));
    await deps.bridge.confirm({ attemptId: 'attempt-1' });
    await deps.bridge.cancel({ attemptId: 'attempt-1' });
    expect(invoke).toHaveBeenNthCalledWith(1, 'desktop_continuation_confirm', {
      attemptId: 'attempt-1',
    });
    expect(invoke).toHaveBeenNthCalledWith(2, 'desktop_continuation_cancel', {
      attemptId: 'attempt-1',
    });
    // The payload of every bridge call is exactly `{ attemptId }`. That is the
    // guarantee worth pinning: no state, no verifier, no nonce, no token.
    for (const call of invoke.mock.calls as unknown as unknown[][]) {
      const payload = call[1];
      if (payload) expect(Object.keys(payload)).toEqual(['attemptId']);
    }
  });

  it('returns only an email and a display name from the identity wait', async () => {
    const invoke = vi.fn(async () => ({
      email: 'someone@example.test',
      displayName: 'Someone',
    }));
    const deps = continuationDeps(CONTEXT, options({ invoke }));
    const identity = await deps.bridge.awaitIdentity({ attemptId: 'attempt-1' });
    expect(Object.keys(identity).sort()).toEqual(['displayName', 'email']);
  });
});
