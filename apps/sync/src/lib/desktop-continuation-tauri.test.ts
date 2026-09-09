import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  classifyDelivery,
  continuationDeps,
  loadContinuationContext,
  type ContinuationContext,
} from './desktop-continuation-tauri';

const CONTEXT: ContinuationContext = {
  installAttemptId: '11111111-1111-4111-8111-111111111111',
  appVersion: '1.4.2',
  apiBase: 'http://127.0.0.1:1',
};

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    invoke: vi.fn(async () => undefined),
    fetch: vi.fn(async () => response(200)),
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

  it('fetches the config from the desktop route on the resolved base', async () => {
    opts.fetch = vi.fn(async () => response(200, { protocolVersion: 1 }));
    const deps = continuationDeps(CONTEXT, opts);
    await expect(deps.fetchConfig()).resolves.toEqual({ protocolVersion: 1 });
    expect(opts.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1/v1/desktop/onboarding/config',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('treats a non-2xx config response as no config at all', async () => {
    // A captive portal or a proxy login page answers 200 with HTML and a 404
    // answers with JSON that is not a config. Neither is a document to act on.
    opts.fetch = vi.fn(async () => response(404, { message: 'Not Found' }));
    const deps = continuationDeps(CONTEXT, opts);
    await expect(deps.fetchConfig()).rejects.toThrow();
  });

  it('keeps a receipt queued when the network is gone', async () => {
    opts.fetch = vi.fn(async () => {
      throw new Error('Failed to fetch');
    });
    const deps = continuationDeps(CONTEXT, opts);
    await expect(
      deps.deliver({ path: '/v1/desktop/onboarding/launch', body: { eventId: 'e1' } }),
    ).resolves.toBe('retry');
  });

  it('posts a receipt verbatim to its own path', async () => {
    const deps = continuationDeps(CONTEXT, opts);
    const receipt = {
      path: '/v1/desktop/onboarding/progress',
      body: { eventId: 'e1', occurredAt: '2026-09-09T00:00:00.000Z', outcome: 'started' },
    };
    await deps.deliver(receipt);
    expect(opts.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:1/v1/desktop/onboarding/progress',
      expect.objectContaining({ body: JSON.stringify(receipt.body) }),
    );
  });

  it('sends no authorization header on the anonymous routes', async () => {
    // These routes are called before anyone is signed in. A bearer token here
    // would be a credential the renderer had no business holding.
    const deps = continuationDeps(CONTEXT, opts);
    await deps.deliver({ path: '/v1/desktop/onboarding/launch', body: { eventId: 'e1' } });
    const call = (opts.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('authorization');
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
