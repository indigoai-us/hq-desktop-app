import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CompanyStep.svelte', import.meta.url), 'utf8');

describe('CompanyStep name prefill gate', () => {
  it('keeps the server field value unchanged when the flag is off', () => {
    expect(source).toContain('namePrefillEnabled?: boolean');
    expect(source).toContain('namePrefillEnabled = false');
    expect(source).toMatch(/if \(namePrefillEnabled && path\.kind === 'create'\)/);
    expect(source).toMatch(/namePrefillEnabled && path\.kind === 'create'[\s\S]*?companyNameFromEmail\(signedInEmail\)/);
    expect(source).toMatch(/prefilledCompanyName \?\? field\.value \?\? ''/);
  });
});
