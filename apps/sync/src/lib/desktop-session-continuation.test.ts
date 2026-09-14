import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  beginContinuation,
  cancelContinuation,
  classifyContinuationError,
  confirmContinuation,
  decideRollout,
  flushReceipts,
  launchReceipt,
  MAX_QUEUED_RECEIPTS,
  parseContinuationConfig,
  progressReceipt,
  recordReceipt,
  resolveRollout,
  rolloutBucket,
  SUPPORTED_PROTOCOL_VERSION,
  type ContinuationConfig,
  type ContinuationDeps,
  type ContinuationReceipt,
  type ContinuationState,
  type DeliveryResult,
  type VerifiedIdentity,
} from './desktop-session-continuation';

const INSTALL = '11111111-1111-4111-8111-111111111111';
const IDENTITY: VerifiedIdentity = {
  email: 'someone@example.test',
  displayName: 'Someone',
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    dump: () => [...map.entries()],
  };
}

interface Harness {
  deps: ContinuationDeps;
  delivered: ContinuationReceipt[];
  storage: ReturnType<typeof memoryStorage>;
  setDelivery(result: DeliveryResult | (() => DeliveryResult)): void;
  advance(ms: number): void;
}

function harness(overrides: Partial<ContinuationDeps> = {}): Harness {
  const storage = memoryStorage();
  const delivered: ContinuationReceipt[] = [];
  let clock = 1_800_000_000_000;
  let counter = 0;
  let delivery: DeliveryResult | (() => DeliveryResult) = 'recorded';

  const deps: ContinuationDeps = {
    bridge: {
      mayStart: vi.fn(async () => null as string | null),
      start: vi.fn(async () => ({ attemptId: 'attempt-1' })),
      awaitIdentity: vi.fn(async () => IDENTITY),
      confirm: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    },
    fetchConfig: vi.fn(async () => enabledConfig()),
    deliver: vi.fn(async (receipt: ContinuationReceipt) => {
      const result = typeof delivery === 'function' ? delivery() : delivery;
      if (result !== 'retry') delivered.push(receipt);
      return result;
    }),
    storage,
    now: () => clock,
    newId: () => `id-${(counter += 1)}`,
    installAttemptId: INSTALL,
    appVersion: '1.4.2',
    platform: 'mac',
    ...overrides,
  };

  return {
    deps,
    delivered,
    storage,
    setDelivery: (result) => void (delivery = result),
    advance: (ms) => void (clock += ms),
  };
}

function enabledConfig(): ContinuationConfig {
  return {
    protocolVersion: SUPPORTED_PROTOCOL_VERSION,
    minimumDesktopVersion: '1.0.0',
    variant: 'continuation',
    rolloutPercent: 100,
  };
}

function outcomes(receipts: ContinuationReceipt[]): string[] {
  return receipts
    .filter((receipt) => receipt.path.endsWith('/progress'))
    .map((receipt) => String(receipt.body.outcome));
}

/* ------------------------------------------------------------------ */

describe('the rollout document is never half-trusted', () => {
  it('accepts a well-formed document', () => {
    expect(parseContinuationConfig(enabledConfig())).toEqual(enabledConfig());
  });

  it.each([
    ['not an object', 'nope'],
    ['null', null],
    ['an array', []],
    ['an unknown protocol version', { ...enabledConfig(), protocolVersion: 2 }],
    ['a missing minimum version', { ...enabledConfig(), minimumDesktopVersion: undefined }],
    ['an unknown variant', { ...enabledConfig(), variant: 'continuation-v2' }],
    ['a fractional percentage', { ...enabledConfig(), rolloutPercent: 12.5 }],
    ['a negative percentage', { ...enabledConfig(), rolloutPercent: -1 }],
    ['a percentage above 100', { ...enabledConfig(), rolloutPercent: 101 }],
    ['a string percentage', { ...enabledConfig(), rolloutPercent: '100' }],
    ['an error body from an older backend', { message: 'Not Found' }],
  ])('refuses %s', (_label, body) => {
    expect(parseContinuationConfig(body)).toBeNull();
  });

  it('refuses a percentage rather than clamping it', () => {
    // Clamping 101 to 100 would turn a typo into a full rollout. There is no
    // reading of an out-of-range number that is safer than "I do not understand
    // this document".
    expect(parseContinuationConfig({ ...enabledConfig(), rolloutPercent: 1000 })).toBeNull();
  });
});

describe('the rollout decision', () => {
  it('is disabled when there is no config at all', () => {
    expect(decideRollout(null, '9.9.9', INSTALL)).toEqual({
      enabled: false,
      reason: 'unrecognised',
    });
  });

  it('is disabled on the control arm', () => {
    const config = { ...enabledConfig(), variant: 'control' as const };
    expect(decideRollout(config, '9.9.9', INSTALL)).toEqual({ enabled: false, reason: 'control' });
  });

  it('refuses a build older than the minimum, and accepts one at it', () => {
    const config = { ...enabledConfig(), minimumDesktopVersion: '1.4.2' };
    expect(decideRollout(config, '1.4.1', INSTALL)).toEqual({
      enabled: false,
      reason: 'build_too_old',
    });
    expect(decideRollout(config, '1.4.2', INSTALL).enabled).toBe(true);
    expect(decideRollout(config, '1.10.0', INSTALL).enabled).toBe(true);
  });

  it("disables every build against the backend's unreachable minimum", () => {
    // 999.999.999 is what the backend answers when its own minimum is unset or
    // malformed. Nothing shipped is newer, which is the point.
    const config = { ...enabledConfig(), minimumDesktopVersion: '999.999.999' };
    expect(decideRollout(config, '1.4.2', INSTALL).enabled).toBe(false);
  });

  it('treats an unparseable version on either side as not understood', () => {
    expect(decideRollout(enabledConfig(), '1.4.2-beta.1', INSTALL).enabled).toBe(false);
    const config = { ...enabledConfig(), minimumDesktopVersion: 'latest' };
    expect(decideRollout(config, '1.4.2', INSTALL).enabled).toBe(false);
  });

  it('enables nobody at zero percent and everybody at a hundred', () => {
    const off = { ...enabledConfig(), rolloutPercent: 0 };
    expect(decideRollout(off, '9.9.9', INSTALL)).toEqual({
      enabled: false,
      reason: 'not_in_rollout',
    });
    for (let n = 0; n < 100; n += 1) {
      expect(decideRollout(enabledConfig(), '9.9.9', `install-${n}`).enabled).toBe(true);
    }
  });

  it('keeps one installation on the same side of the line', () => {
    const config = { ...enabledConfig(), rolloutPercent: 50 };
    const first = decideRollout(config, '9.9.9', INSTALL);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      expect(decideRollout(config, '9.9.9', INSTALL)).toEqual(first);
    }
  });

  it('spreads installations across the bucket range', () => {
    const buckets = new Set(
      Array.from({ length: 300 }, (_value, index) => rolloutBucket(`install-${index}`)),
    );
    expect(buckets.size).toBeGreaterThan(50);
  });
});

describe('fetching the rollout document', () => {
  it('is disabled when the request fails', async () => {
    const { deps } = harness({
      fetchConfig: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    });
    await expect(resolveRollout(deps)).resolves.toEqual({
      enabled: false,
      reason: 'unavailable',
    });
  });

  it('is disabled when the body is not a config document', async () => {
    const { deps } = harness({ fetchConfig: vi.fn(async () => '<html>proxy login</html>') });
    await expect(resolveRollout(deps)).resolves.toEqual({
      enabled: false,
      reason: 'unrecognised',
    });
  });

  it('never throws out of resolveRollout', async () => {
    const { deps } = harness({
      fetchConfig: vi.fn(() => Promise.reject(new TypeError('NetworkError'))),
    });
    await expect(resolveRollout(deps)).resolves.toMatchObject({ enabled: false });
  });
});

describe('the receipt queue', () => {
  it('persists a receipt before it tries to deliver it', async () => {
    const { deps, storage } = harness();
    let sawStoredReceipt = false;
    (deps.deliver as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      sawStoredReceipt = storage.dump().some(([, value]) => value.includes('app_first_launch_probe'));
      return 'recorded' as DeliveryResult;
    });
    await recordReceipt(deps, {
      path: '/v1/desktop/onboarding/launch',
      body: { marker: 'app_first_launch_probe' },
    });
    expect(sawStoredReceipt).toBe(true);
  });

  it('keeps a receipt the server could not accept yet and replays it later', async () => {
    const { deps, delivered, setDelivery } = harness();
    setDelivery('retry');
    await recordReceipt(deps, launchReceipt(deps));
    expect(delivered).toHaveLength(0);

    // A restart is just a new module instance over the same storage.
    setDelivery('recorded');
    await flushReceipts(deps);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].path).toBe('/v1/desktop/onboarding/launch');
  });

  it('replays the receipt unchanged, timestamp and all', async () => {
    // The server's sort key includes occurredAt, so a re-stamped retry writes a
    // SECOND row instead of deduplicating against the first. The receipt has to
    // be minted once and replayed byte for byte.
    const { deps, delivered, setDelivery, advance } = harness();
    setDelivery('retry');
    const minted = launchReceipt(deps);
    await recordReceipt(deps, minted);

    advance(90_000);
    setDelivery('recorded');
    await flushReceipts(deps);
    expect(delivered[0].body.occurredAt).toBe(minted.body.occurredAt);
    expect(delivered[0].body.eventId).toBe(minted.body.eventId);
  });

  it('drops a receipt the server refused rather than retrying it forever', async () => {
    // A 400 means the contents are wrong. Resending will fail identically, and
    // a permanently stuck receipt would block every later one behind it.
    const { deps, setDelivery, storage } = harness();
    setDelivery('rejected');
    await recordReceipt(deps, launchReceipt(deps));
    expect(storage.getItem('hq-sync:desktop-continuation-receipts:v1')).toContain('"receipts":[]');
  });

  it('treats a thrown delivery as retryable, not as a rejection', async () => {
    const { deps, delivered } = harness();
    (deps.deliver as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('offline'));
    await recordReceipt(deps, launchReceipt(deps));
    expect(delivered).toHaveLength(0);
    await flushReceipts(deps);
    expect(delivered).toHaveLength(1);
  });

  it('bounds the queue so an unreachable backend cannot grow it without limit', async () => {
    const { deps, setDelivery, storage } = harness();
    setDelivery('retry');
    for (let index = 0; index < MAX_QUEUED_RECEIPTS + 20; index += 1) {
      await recordReceipt(deps, launchReceipt(deps));
    }
    const stored = JSON.parse(
      storage.getItem('hq-sync:desktop-continuation-receipts:v1') ?? '{"receipts":[]}',
    ) as { receipts: unknown[] };
    expect(stored.receipts).toHaveLength(MAX_QUEUED_RECEIPTS);
  });

  it('survives a corrupt queue instead of failing sign-in', async () => {
    const { deps, delivered, storage } = harness();
    storage.setItem('hq-sync:desktop-continuation-receipts:v1', '{ this is not json');
    await recordReceipt(deps, launchReceipt(deps));
    expect(delivered).toHaveLength(1);
  });

  it('carries no identity or credential field in any receipt it builds', () => {
    const { deps } = harness();
    const receipts = [
      launchReceipt(deps),
      progressReceipt(deps, { sessionId: 's', outcome: 'started', variant: 'continuation' }),
      progressReceipt(deps, {
        sessionId: 's',
        outcome: 'failed',
        variant: 'continuation',
        errorKind: 'state_mismatch',
        durationMs: 1234,
      }),
    ];
    const serialised = JSON.stringify(receipts);
    for (const forbidden of [
      'personUid',
      'companyUid',
      'email',
      'idToken',
      'accessToken',
      'refreshToken',
      'nonce',
      'verifier',
      '@',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
    // `state` is checked as a KEY, not as a substring: `state_mismatch` is a
    // legitimate errorKind value and would false-positive a naive search, which
    // is exactly the kind of near-miss that gets a guard deleted later.
    for (const receipt of receipts) {
      expect(Object.keys(receipt.body)).not.toContain('state');
      expect(Object.keys(receipt.body)).not.toContain('nonce');
      expect(Object.keys(receipt.body)).not.toContain('codeVerifier');
    }
  });

  it('rounds durationMs to a non-negative integer', () => {
    const { deps } = harness();
    const receipt = progressReceipt(deps, {
      sessionId: 's',
      outcome: 'failed',
      variant: 'continuation',
      durationMs: -5.7,
    });
    expect(receipt.body.durationMs).toBe(0);
  });
});

describe('one continuation attempt', () => {
  let states: ContinuationState[];
  const collect = (state: ContinuationState) => void states.push(state);

  beforeEach(() => {
    states = [];
  });

  it('walks to the confirmation prompt and writes nothing before it', async () => {
    const { deps, delivered } = harness();
    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, collect);

    expect(final).toMatchObject({ phase: 'confirming', identity: IDENTITY });
    expect(deps.bridge.confirm).not.toHaveBeenCalled();
    expect(states.map((state) => state.phase)).toEqual(['opening', 'waiting', 'confirming']);
    expect(outcomes(delivered)).toEqual(['started', 'browser_opened', 'identity_verified']);
  });

  it('writes to disk only once the person confirms', async () => {
    const { deps } = harness();
    const confirming = await beginContinuation(
      deps,
      { enabled: true, config: enabledConfig() },
      collect,
    );
    if (confirming.phase !== 'confirming') throw new Error('expected a confirmation');

    const activated = await confirmContinuation(deps, confirming, collect);
    expect(deps.bridge.confirm).toHaveBeenCalledWith({ attemptId: confirming.attemptId });
    expect(activated).toEqual({ phase: 'activated', identity: IDENTITY });
  });

  it('leaves the app unauthenticated when the credentials cannot be stored', async () => {
    // Telling somebody they are signed in when nothing was written produces an
    // app that forgets them at the next launch, which is worse than the truth.
    const { deps, delivered } = harness();
    (deps.bridge.confirm as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('failed to persist credentials to disk'),
    );
    const confirming = await beginContinuation(
      deps,
      { enabled: true, config: enabledConfig() },
      collect,
    );
    if (confirming.phase !== 'confirming') throw new Error('expected a confirmation');

    const result = await confirmContinuation(deps, confirming, collect);
    expect(result).toEqual({ phase: 'fallback', errorKind: 'persistence_failed' });
    expect(outcomes(delivered).at(-1)).toBe('failed');
  });

  it('falls back to the provider buttons when the browser will not open', async () => {
    const { deps, delivered } = harness();
    (deps.bridge.start as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error(JSON.stringify({ code: 'OAUTH_PORT_IN_USE', message: 'port busy' })),
    );
    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, collect);

    expect(final).toEqual({ phase: 'fallback', errorKind: 'port_in_use' });
    expect(outcomes(delivered)).toEqual(['started', 'failed']);
    expect(delivered.at(-1)?.body.errorKind).toBe('port_in_use');
  });

  it('reports a cancellation as cancelled, not as a failure', async () => {
    const { deps, delivered } = harness();
    (deps.bridge.awaitIdentity as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Sign-in was cancelled.'),
    );
    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, collect);

    expect(final).toEqual({ phase: 'fallback', errorKind: 'cancelled' });
    expect(outcomes(delivered).at(-1)).toBe('cancelled');
  });

  it('discards the pending tokens when the person picks another account', async () => {
    const { deps, delivered } = harness();
    const confirming = await beginContinuation(
      deps,
      { enabled: true, config: enabledConfig() },
      collect,
    );
    if (confirming.phase !== 'confirming') throw new Error('expected a confirmation');

    await cancelContinuation(deps, confirming, collect);
    expect(deps.bridge.cancel).toHaveBeenCalledWith({ attemptId: confirming.attemptId });
    expect(deps.bridge.confirm).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ phase: 'fallback', errorKind: 'cancelled' });
    expect(outcomes(delivered).at(-1)).toBe('cancelled');
  });

  it('still ends up on the fallback when cancel itself fails', async () => {
    // The native attempt may already be gone — expiry, a newer sign-in. Either
    // way the pending tokens are not there any more, which is what Cancel was
    // asking for.
    const { deps } = harness();
    (deps.bridge.cancel as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no such attempt'));
    const confirming = await beginContinuation(
      deps,
      { enabled: true, config: enabledConfig() },
      collect,
    );
    await cancelContinuation(deps, confirming, collect);
    expect(states.at(-1)).toEqual({ phase: 'fallback', errorKind: 'cancelled' });
  });

  it('does nothing at all when the rollout is off', async () => {
    const { deps, delivered } = harness();
    const final = await beginContinuation(
      deps,
      { enabled: false, reason: 'control' },
      collect,
    );

    expect(final.phase).toBe('fallback');
    expect(deps.bridge.start).not.toHaveBeenCalled();
    // No progress rows either. The control arm has to look like today's app in
    // the data as well as on screen, or the two arms are distinguishable for
    // reasons that have nothing to do with the experiment.
    expect(delivered).toHaveLength(0);
  });

  it('does not block on a telemetry endpoint that is down', async () => {
    const { deps, setDelivery } = harness();
    setDelivery('retry');
    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, collect);
    expect(final.phase).toBe('confirming');
  });

  it('releases a just-armed attempt when explicit provider sign-in wins the race', async () => {
    const { deps, delivered } = harness();
    let continuationStillPreferred = true;
    (deps.bridge.start as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // This mirrors a provider click between native listener arming and the
      // renderer receiving its attempt id. The continuation cannot be allowed
      // to hold the listener after the person explicitly chose a provider.
      continuationStillPreferred = false;
      return { attemptId: 'attempt-1' };
    });

    const final = await beginContinuation(
      deps,
      { enabled: true, config: enabledConfig() },
      collect,
      () => continuationStillPreferred,
    );

    expect(deps.bridge.cancel).toHaveBeenCalledWith({ attemptId: 'attempt-1' });
    expect(deps.bridge.awaitIdentity).not.toHaveBeenCalled();
    expect(final).toEqual({ phase: 'fallback', errorKind: 'cancelled' });
    expect(outcomes(delivered)).toEqual(['started', 'cancelled']);
  });
});

describe('error classification is a closed set', () => {
  it.each([
    [JSON.stringify({ code: 'OAUTH_PORT_IN_USE' }), 'port_in_use'],
    [JSON.stringify({ code: 'OAUTH_PROVIDER_ERROR' }), 'provider_denied'],
    ['Sign-in was cancelled.', 'cancelled'],
    ['OAuth state mismatch — possible CSRF, aborting.', 'state_mismatch'],
    ['Timed out waiting for sign-in (5 minutes).', 'expired'],
    ['No person entity for this account', 'person_missing'],
    ['Token exchange failed (400)', 'invalid_token'],
    ['network unreachable', 'offline'],
    ['could not open the browser', 'browser_open_failed'],
    ['failed to persist tokens', 'persistence_failed'],
    ['something nobody predicted', 'unavailable'],
  ])('maps %s', (message, expected) => {
    expect(classifyContinuationError(new Error(message))).toBe(expected);
  });

  it('never returns free text, whatever it is handed', () => {
    const closed = new Set([
      'offline',
      'port_in_use',
      'browser_open_failed',
      'provider_denied',
      'state_mismatch',
      'invalid_token',
      'person_missing',
      'expired',
      'cancelled',
      'persistence_failed',
      'unavailable',
    ]);
    for (const input of [
      undefined,
      null,
      '',
      42,
      { message: 'an object' },
      new Error('user@example.com could not sign in'),
      'eyJhbGciOiJSUzI1NiJ9.payload.signature',
    ]) {
      expect(closed.has(classifyContinuationError(input))).toBe(true);
    }
  });
});

describe('a machine that must not start an attempt', () => {
  it.each([
    ['is already signed in', 'CONTINUATION_REFUSED_SIGNED_IN'],
    ['just signed out on purpose', 'CONTINUATION_REFUSED_SIGNED_OUT'],
    ['already has a login in flight', 'CONTINUATION_REFUSED_IN_FLIGHT'],
    ['is applying an update', 'CONTINUATION_REFUSED_UPDATING'],
    ['is not on its first launch', 'CONTINUATION_REFUSED_NOT_FIRST_LAUNCH'],
  ])('falls back silently when it %s', async (_label, code) => {
    const { deps, delivered } = harness();
    deps.bridge.mayStart = vi.fn(async () => code);
    const states: ContinuationState[] = [];

    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, (next) =>
      states.push(next),
    );

    expect(final).toEqual({ phase: 'fallback', errorKind: 'unavailable' });
    // Nothing is armed and nothing is written down. Eligibility is a fact
    // about the installation, not the outcome of an attempt — a started/failed
    // pair here would report every ineligible app open as a failure and bury
    // the signal this work exists to produce.
    expect(deps.bridge.start).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(states).toEqual([{ phase: 'fallback', errorKind: 'unavailable' }]);
  });

  it('treats an unanswerable eligibility check as a refusal', async () => {
    const { deps, delivered } = harness();
    deps.bridge.mayStart = vi.fn(async () => {
      throw new Error('bridge unavailable');
    });

    const final = await beginContinuation(deps, { enabled: true, config: enabledConfig() }, () => {});

    expect(final).toEqual({ phase: 'fallback', errorKind: 'unavailable' });
    expect(deps.bridge.start).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
  });

  it('asks before it writes, not after', async () => {
    const order: string[] = [];
    const { deps } = harness();
    deps.bridge.mayStart = vi.fn(async () => {
      order.push('mayStart');
      return null;
    });
    const deliver = deps.deliver;
    deps.deliver = vi.fn(async (receipt) => {
      order.push(`deliver:${receipt.body.outcome ?? 'launch'}`);
      return deliver(receipt);
    });

    await beginContinuation(deps, { enabled: true, config: enabledConfig() }, () => {});

    expect(order[0]).toBe('mayStart');
  });
});
