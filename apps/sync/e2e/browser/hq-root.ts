import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** Carries the run's folder from the runner to its workers, which load this file again. */
const KEY = 'HQ_DESKTOP_E2E_ROOT';
const PREFIX = 'hq-desktop-e2e-';

/**
 * The HQ folder the preview server reads `/__hq/` from (its HQ_ROOT) during the
 * browser suite. Each run makes its own folder under the system temp dir, never
 * ~/hq, so a spec can write brief runs and import reports into it. The global
 * teardown deletes it.
 */
export const E2E_HQ_ROOT: string = process.env[KEY] || (process.env[KEY] = mkdtempSync(join(realpathSync(tmpdir()), PREFIX)));

/** Throws unless `root` is one of this suite's run folders: directly under the temp dir, with the prefix, and not the real HQ. */
export function assertRunRoot(root: string): void {
  const base = realpathSync(tmpdir()) + sep;
  const name = root.slice(base.length);
  if (!root.startsWith(base) || !name.startsWith(PREFIX) || name.includes(sep) || root.startsWith(join(homedir(), 'hq'))) {
    throw new Error(`browser e2e HQ root is not a run folder under the temp dir: ${root}`);
  }
}
