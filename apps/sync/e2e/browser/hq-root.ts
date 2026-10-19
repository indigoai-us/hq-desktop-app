import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The HQ folder the preview server reads `/__hq/` from (its HQ_ROOT) during the
 * browser suite. A throwaway folder under the system temp dir, never ~/hq, so a
 * spec can write brief runs and import reports into it.
 */
export const E2E_HQ_ROOT = join(tmpdir(), 'hq-desktop-e2e-root');
