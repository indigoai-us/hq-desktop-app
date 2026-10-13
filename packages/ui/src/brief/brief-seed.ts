/**
 * Dev-harness seam: when a seed is configured, the brief serves that day
 * instead of reading the adapter. Kept dependency-free so the harness can set
 * it without pulling the brief chunk into the main bundle. Never set in the
 * production app.
 */
import type { BriefInput } from "./brief-types.js";

let seed: (() => BriefInput) | null = null;

export function configureBriefSeed(next: (() => BriefInput) | null): void {
  seed = next;
}

export function briefSeed(): (() => BriefInput) | null {
  return seed;
}
