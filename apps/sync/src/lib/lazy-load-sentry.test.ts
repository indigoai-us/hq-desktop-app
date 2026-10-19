import { afterEach, describe, expect, it, vi } from 'vitest';

const captured: Array<{ error: unknown; tags: Record<string, string>; fingerprint: string[] }> = [];
vi.mock('@sentry/svelte', () => ({
  withScope: (fn: (scope: unknown) => void) => {
    const tags: Record<string, string> = {};
    let fingerprint: string[] = [];
    const scope = {
      setTag: (k: string, v: string) => (tags[k] = v),
      setFingerprint: (f: string[]) => (fingerprint = f),
    };
    fn(scope);
    captured.push({ error: pendingError, tags, fingerprint });
  },
  captureException: (error: unknown) => {
    pendingError = error;
  },
}));
let pendingError: unknown = null;

import { reportLazyLoadFailure, setLazyLoadFailureReporter } from '@hq/ui/lazy-load-report';
import { installLazyLoadSentryReporter } from './lazy-load-sentry';

afterEach(() => {
  setLazyLoadFailureReporter(null);
  captured.length = 0;
  vi.restoreAllMocks();
});

describe('lazy chunk failures reach Sentry', () => {
  it('captures the error tagged with the window and the surface', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    installLazyLoadSentryReporter('desktop-alt');
    const error = new TypeError('Importing a module script failed.');
    reportLazyLoadFailure('TeamPage', error);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.error).toBe(error);
    expect(captured[0]!.tags).toEqual({ window_label: 'desktop-alt', lazy_door: 'TeamPage' });
    expect(captured[0]!.fingerprint).toEqual(['lazy-door', 'TeamPage', 'desktop-alt']);
  });
});
