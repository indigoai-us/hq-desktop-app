/**
 * White-label branding fixtures for the desktop UI chrome harness (US-007).
 *
 * Tests inject a brand record without any live hq-pro backend. Shape is frozen
 * to match hq-pro `CompanyBrandSettings` so future product code and this
 * harness stay aligned.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Frozen shape of hq-pro `CompanyBrandSettings` — keep in lockstep with the
 * server type. Do not add fields here without updating hq-pro first.
 */
export interface CompanyBrandSettings {
  logoUrlLight: string;
  logoUrlDark: string;
  accentColor: string;
}

/** Built-in brand fixture used when no env override is set. */
export const TEST_BRAND: CompanyBrandSettings = Object.freeze({
  logoUrlLight: 'https://fixtures.test/logo-light.svg',
  logoUrlDark: 'https://fixtures.test/logo-dark.svg',
  accentColor: '#6633cc',
});

/**
 * Whether the signed-in company is entitled to white-label chrome.
 * Product wiring lands in US-005; the harness carries the fixture now.
 */
export type BrandEntitlement = 'entitled' | 'not_entitled';

/** Default entitlement for default-chrome (HQ) assertions. */
export const TEST_ENTITLEMENT: BrandEntitlement = 'not_entitled';

/**
 * Load a brand fixture for tests.
 *
 * When `HQ_SYNC_BRAND_FIXTURE` is set to a filesystem path, reads that JSON
 * file and returns it as `CompanyBrandSettings`. Otherwise returns
 * `TEST_BRAND`. Absolute paths are used as-is; relative paths resolve from
 * `process.cwd()`.
 */
export function loadBrandFixture(): CompanyBrandSettings {
  const envPath = process.env.HQ_SYNC_BRAND_FIXTURE?.trim();
  if (!envPath) {
    return TEST_BRAND;
  }

  const absolute = envPath.startsWith('/') ? envPath : resolve(process.cwd(), envPath);
  const raw = readFileSync(absolute, 'utf8');
  const parsed = JSON.parse(raw) as Partial<CompanyBrandSettings>;

  if (
    typeof parsed.logoUrlLight !== 'string' ||
    typeof parsed.logoUrlDark !== 'string' ||
    typeof parsed.accentColor !== 'string'
  ) {
    throw new Error(
      `HQ_SYNC_BRAND_FIXTURE at ${absolute} must be JSON with logoUrlLight, logoUrlDark, accentColor strings`,
    );
  }

  return {
    logoUrlLight: parsed.logoUrlLight,
    logoUrlDark: parsed.logoUrlDark,
    accentColor: parsed.accentColor,
  };
}
