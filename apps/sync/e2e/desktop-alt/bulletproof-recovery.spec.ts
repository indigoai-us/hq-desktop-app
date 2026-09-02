import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

describe('bulletproof recovery wiring', () => {
  it('ships a bundled recovery HTML page with no Svelte/desktop-alt dependency', () => {
    const html = read('apps/sync/src-tauri/recovery/index.html');
    expect(html).toContain('data-testid="hq-recovery"');
    expect(html).toContain('Check for updates now');
    expect(html).toContain('Reinstall latest release');
    expect(html).toContain('Reset local UI state');
    expect(html).toContain('Quit');
    expect(html).not.toContain('desktop-alt.html');
    expect(html).not.toContain('/src/desktop-alt');
  });

  it('registers the recovery window capability and native commands', () => {
    const cap = read('apps/sync/src-tauri/capabilities/recovery.json');
    expect(cap).toContain('"recovery"');
    const main = read('apps/sync/src-tauri/src/main.rs');
    expect(main).toContain('crate::recovery::shell_ready');
    expect(main).toContain('crate::recovery::reset_local_ui_state');
    expect(main).toContain('updater::reinstall_latest_release');
  });

  it('reports shell_ready from the HQ Work shell after first paint', () => {
    const shell = read('apps/sync/src/desktop-alt/HqWorkWorkShell.svelte');
    expect(shell).toContain("invokeFn('shell_ready')");
    expect(shell).toContain('onShellReady');
  });
});
