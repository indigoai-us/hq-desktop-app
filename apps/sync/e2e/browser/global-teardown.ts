import { rmSync } from 'node:fs';
import { E2E_HQ_ROOT, assertRunRoot } from './hq-root';

/** Deletes the run's HQ folder, and only that folder. */
export default function globalTeardown(): void {
  assertRunRoot(E2E_HQ_ROOT);
  rmSync(E2E_HQ_ROOT, { recursive: true, force: true });
}
