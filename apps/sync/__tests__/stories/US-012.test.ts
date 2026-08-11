import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolvePendingDesktopRoute } from '../../src/desktop-alt/route';
import { companyConsoleUrl } from '../../src/desktop-alt/lib/hq-console';

describe('US-012 company secrets (US-021 console drop — no secrets request)', () => {
  it('removes SecretsPanel / SecretEnvRow and the get_company_secrets command', () => {
    expect(existsSync(resolve(process.cwd(), 'src/desktop-alt/panels/SecretsPanel.svelte'))).toBe(
      false,
    );
    expect(
      existsSync(resolve(process.cwd(), 'src/desktop-alt/components/SecretEnvRow.svelte')),
    ).toBe(false);
    const main = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');
    const cmd = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/commands/desktop_alt.rs'),
      'utf8',
    );
    expect(main).not.toContain('get_company_secrets');
    expect(cmd).not.toContain('pub async fn get_company_secrets');
    expect(resolvePendingDesktopRoute('company:indigo:secrets')).toEqual({
      mode: 'console',
      url: `${companyConsoleUrl('indigo')}/secrets`,
      landOn: { kind: 'company', slug: 'indigo', tab: 'overview' },
    });
  });
});
