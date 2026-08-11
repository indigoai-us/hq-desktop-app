import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DesktopAltHarness, readRepoFile } from './harness';

/**
 * US-021: desktop never requests company secrets.
 *
 * Strengthened from the old "metadata-only projection" contract — the
 * `get_company_secrets` command is gone, so there is no secrets invoke path
 * and no SecretEnv / SecretItem types in the desktop app sources.
 */

const REPO_ROOT = process.cwd();

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      // Skip build artifacts and node_modules if present under src.
      if (name === 'node_modules' || name === 'target' || name === 'dist') continue;
      walkFiles(full, out);
    } else if (/\.(ts|tsx|svelte|rs|js|mjs|cjs)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function sourceContains(pathFromRepo: string, needle: RegExp | string): boolean {
  const text = readFileSync(join(REPO_ROOT, pathFromRepo), 'utf8');
  return typeof needle === 'string' ? text.includes(needle) : needle.test(text);
}

describe('desktop-alt secrets never leak', () => {
  it('does not register get_company_secrets on the desktop command surface', () => {
    const main = readRepoFile('src-tauri/src/main.rs');
    const desktopAlt = readRepoFile('src-tauri/src/commands/desktop_alt.rs');

    expect(main).not.toContain('get_company_secrets');
    expect(desktopAlt).not.toContain('pub async fn get_company_secrets');
    expect(desktopAlt).not.toContain('get_company_secrets(');
    // Summary must not fetch secrets.
    expect(desktopAlt).toMatch(/secrets:\s*0/);
  });

  it('has no get_company_secrets / SecretEnv / SecretItem in app frontend or tauri sources', () => {
    const roots = ['src', 'src-tauri/src'];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walkFiles(join(REPO_ROOT, root))) {
        const rel = file.slice(REPO_ROOT.length + 1);
        const text = readFileSync(file, 'utf8');
        if (
          text.includes('get_company_secrets') ||
          /\bSecretEnv\b/.test(text) ||
          /\bSecretItem\b/.test(text)
        ) {
          offenders.push(rel);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('harness has no secrets invoke path or intercept fixture', () => {
    const harness = readRepoFile('e2e/desktop-alt/harness.ts');
    expect(harness).not.toContain('interceptGetCompanySecrets');
    expect(harness).not.toContain('sanitizeSecretsResponse');
    expect(harness).not.toContain('assertSecretsSourceContracts');
    expect(harness).not.toMatch(/export interface SecretEnv\b/);
    expect(harness).not.toMatch(/export interface SecretItem\b/);
  });

  it('company store never loads secrets', () => {
    expect(sourceContains('src/desktop-alt/lib/company-store.svelte.ts', 'get_company_secrets')).toBe(
      false,
    );
    expect(sourceContains('src/desktop-alt/lib/company-store.svelte.ts', 'loadSecrets')).toBe(false);
    expect(sourceContains('src/desktop-alt/lib/company-store.svelte.ts', "'secrets'")).toBe(false);
  });

  it('scripted harness still boots without a secrets command', () => {
    const app = new DesktopAltHarness('qa@getindigo.ai');
    expect(app.bootApp().desktopAltEnabled).toBe(true);
  });
});
