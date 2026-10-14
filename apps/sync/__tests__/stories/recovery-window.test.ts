// @vitest-environment happy-dom
//
// Behaviour of the bundled recovery page (src-tauri/recovery/index.html).
// The page is plain HTML + inline script, so the test mounts its body and runs
// its script against a seeded `window.__HQ_RECOVERY__`, then reads what the
// user would see.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const html = readFileSync(
  resolve(__dirname, '../../src-tauri/recovery/index.html'),
  'utf8',
);

type RecoveryInit = {
  version: string;
  pendingUpdate: { version: string } | null;
  trigger: string;
};

function mount(init: RecoveryInit) {
  const body = html.match(/<body>([\s\S]*?)<script>/)?.[1];
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!body || !script) throw new Error('recovery page markup not found');
  document.body.innerHTML = body;
  (window as unknown as { __HQ_RECOVERY__: RecoveryInit }).__HQ_RECOVERY__ = init;
  new Function(script)();
  return {
    primary: document.getElementById('primary') as HTMLButtonElement,
    intro: document.getElementById('intro')?.textContent ?? '',
  };
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (window as unknown as { __HQ_RECOVERY__?: RecoveryInit }).__HQ_RECOVERY__;
});

describe('recovery window install label', () => {
  it('labels a newer target as a plain install, not a rollback', () => {
    const { primary } = mount({
      version: '0.10.400',
      pendingUpdate: { version: '0.10.401' },
      trigger: 'menu',
    });
    expect(primary.hidden).toBe(false);
    expect(primary.textContent).toBe('Install HQ v0.10.401');
  });

  it('labels an older target as a rollback', () => {
    const { primary } = mount({
      version: '0.10.401',
      pendingUpdate: { version: '0.10.400' },
      trigger: 'menu',
    });
    expect(primary.textContent).toBe('Install HQ v0.10.400 (rollback)');
  });

  it('compares numerically, not as strings', () => {
    expect(
      mount({ version: '0.10.99', pendingUpdate: { version: '0.10.100' }, trigger: 'menu' })
        .primary.textContent,
    ).toBe('Install HQ v0.10.100');
    expect(
      mount({ version: '0.10.100', pendingUpdate: { version: '0.10.99' }, trigger: 'menu' })
        .primary.textContent,
    ).toBe('Install HQ v0.10.99 (rollback)');
  });

  it('treats a stable release as newer than its own prerelease', () => {
    expect(
      mount({
        version: '0.10.401-beta.2',
        pendingUpdate: { version: '0.10.401' },
        trigger: 'menu',
      }).primary.textContent,
    ).toBe('Install HQ v0.10.401');
    expect(
      mount({
        version: '0.10.401',
        pendingUpdate: { version: '0.10.401-beta.2' },
        trigger: 'menu',
      }).primary.textContent,
    ).toBe('Install HQ v0.10.401-beta.2 (rollback)');
  });

  it('does not call an unparseable version a rollback', () => {
    expect(
      mount({ version: 'unknown', pendingUpdate: { version: '0.10.401' }, trigger: 'menu' })
        .primary.textContent,
    ).toBe('Install HQ v0.10.401');
  });
});

describe('recovery window intro copy', () => {
  it('does not claim the desktop window failed when opened from the menu', () => {
    const { intro } = mount({ version: '0.10.400', pendingUpdate: null, trigger: 'menu' });
    expect(intro).not.toMatch(/did not finish loading/);
    expect(intro).toMatch(/Sync data is kept/);
  });

  it('keeps the failure copy when the watchdog opened the window', () => {
    const { intro } = mount({
      version: '0.10.400',
      pendingUpdate: null,
      trigger: 'watchdog-timeout',
    });
    expect(intro).toMatch(/did not finish loading/);
  });

  it('describes a crash and safe mode accurately', () => {
    expect(
      mount({ version: '0.10.400', pendingUpdate: null, trigger: 'webview-crash' }).intro,
    ).toMatch(/stopped unexpectedly/);
    expect(
      mount({ version: '0.10.400', pendingUpdate: null, trigger: 'safe-mode' }).intro,
    ).toMatch(/safe mode/i);
  });
});
