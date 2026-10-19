import { readdirSync } from 'node:fs';
import { E2E_HQ_ROOT, assertRunRoot } from './hq-root';

/** The run's HQ folder must be this run's own, and empty, before any spec writes to it. */
export default function globalSetup(): void {
  assertRunRoot(E2E_HQ_ROOT);
  const left = readdirSync(E2E_HQ_ROOT);
  if (left.length) throw new Error(`browser e2e HQ root is not empty: ${E2E_HQ_ROOT} holds ${left.join(', ')}`);
}
