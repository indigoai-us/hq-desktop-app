// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import V4TitleBar from '../../src/desktop-alt/v4/V4TitleBar.svelte';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const normalize = (source: string) => source.replace(/\s+/g, ' ');

describe('desktop sync failure recovery', () => {
  const titleBar = normalize(read('src/desktop-alt/v4/V4TitleBar.svelte'));
  const desktop = normalize(read('src/desktop-alt/DesktopApp.svelte'));
  const corePopover = normalize(read('src/desktop-alt/v4/CorePopover.svelte'));
  const home = normalize(read('src/desktop-alt/pages/HomePage.svelte'));

  it('keeps the titlebar minimal; recovery surfaces live in Core + Home (D-04)', () => {
    expect(titleBar).toContain('data-testid="titlebar-core-pill"');
    expect(titleBar).not.toContain('{model.sentence}');
    expect(titleBar).not.toContain('label="Finish sync in Claude Code"');
    expect(titleBar).not.toContain('class="v4-action"');
    expect(titleBar).not.toContain('Sync initialized');
    // Home / Core still own conflict + cloud recovery.
    expect(corePopover).toContain('data-testid="core-popover-rescue-card"');
    expect(home).toContain('conflicts');
  });

  it('DesktopApp still wires failure context into the shell for Home/Core', () => {
    expect(desktop).toContain('errorMessage={syncErrorMessage}');
    expect(desktop).toContain('errorCompany={syncErrorCompany}');
    expect(desktop).toContain('{hqFolderPath}');
    expect(desktop).toContain('onretry={syncState ===');
  });

  it('uses the shared Claude launcher, which retains clipboard fallback', () => {
    const launcher = normalize(read('src/components/OpenInClaudeCodeButton.svelte'));
    expect(launcher).toContain("await invoke('open_claude_code_link', { url })");
    expect(launcher).toContain('await navigator.clipboard.writeText(prompt)');
  });

  it('routes auth expiry through the one-click reauth bridge instead of settings or refresh retry', () => {
    expect(desktop).toContain("await invoke('begin_reauth')");
    expect(desktop).toContain("state: 'reauth'");
    expect(desktop).toContain("syncState === 'auth-error' ? handleSignInAgain : handleSyncAll");
    expect(desktop).not.toContain("await invoke('refresh_tokens'); await handleSyncAll()");
  });
});

describe('rendered desktop sync failure recovery', () => {
  let host: HTMLDivElement;
  let component: ReturnType<typeof mount> | null = null;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    invoke.mockReset();
  });

  afterEach(async () => {
    if (component) await unmount(component);
    component = null;
    host.remove();
    vi.useRealTimers();
  });

  it('titlebar stays minimal under error state (recovery not in chrome)', () => {
    component = mount(V4TitleBar, {
      target: host,
      props: {
        version: '0.10.0',
        syncState: 'error',
        watchedCount: 16,
        errorSummary: 'Runner exited with code 2',
        errorMessage: 'hq-sync-runner exited with code 2',
        errorCompany: 'indigo',
        hqFolderPath: '/Users/test/HQ',
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="titlebar-core-pill"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="titlebar-wordmark"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Finish sync in Claude Code');
    expect(host.textContent).not.toContain('Sync failed');
  });

  it('auth-error also stays minimal in the titlebar', () => {
    component = mount(V4TitleBar, {
      target: host,
      props: {
        version: '0.10.0',
        syncState: 'auth-error',
        watchedCount: 16,
      },
    });
    flushSync();
    expect(host.querySelector('[data-testid="titlebar-core-pill"]')).not.toBeNull();
    expect(host.textContent).not.toContain('Ready to reconnect');
    expect(host.querySelector('.v4-dot.error')).toBeNull();
  });
});
