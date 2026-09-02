// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { flushSync, mount, unmount } from 'svelte';
import LibraryList from '../../src/desktop-alt/components/LibraryList.svelte';
import type { LibraryItem } from '../../src/desktop-alt/lib/library';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

let host: HTMLDivElement;
let component: ReturnType<typeof mount> | null = null;

function skill(index: number): LibraryItem {
  return {
    kind: 'skill',
    skill: {
      name: `Skill ${index}`,
      description: `Description ${index}`,
      scope: 'root',
      path: `core/skills/skill-${index}/SKILL.md`,
      allowedTools: [],
    },
  };
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(async () => {
  if (component) await unmount(component);
  component = null;
  host.remove();
});

describe('desktop interaction feedback and render budgets', () => {
  it('bounds the initial Library render and keeps the full collection reachable', () => {
    component = mount(LibraryList, {
      target: host,
      props: { items: Array.from({ length: 120 }, (_, index) => skill(index)) },
    });
    flushSync();

    expect(host.querySelectorAll('.lib-card')).toHaveLength(48);
    const showMore = host.querySelector<HTMLButtonElement>('.collection-footer button');
    expect(showMore?.textContent).toContain('Show 48 more');
    expect(host.querySelector('.collection-footer')?.textContent).toContain('48 of 120');

    showMore?.click();
    flushSync();
    expect(host.querySelectorAll('.lib-card')).toHaveLength(96);
    expect(host.querySelector('.collection-footer')?.textContent).toContain('96 of 120');
  });

  it('gives routed navigation and shared async actions an immediate pending contract', () => {
    const desktop = read('src/desktop-alt/DesktopApp.svelte');
    const palette = read('src/desktop-alt/components/CommandPalette.svelte');
    const openClaude = read('src/components/OpenInClaudeCodeButton.svelte');
    const copyPrompt = read('src/components/CopyPromptButton.svelte');

    expect(desktop).toContain('aria-busy={navigationPending}');
    expect(desktop).toContain('class:active={navigationPending}');
    expect(desktop).toContain('await afterPaint()');
    expect(desktop).not.toContain('navigationPulseTimer');
    expect(palette).toContain('aria-busy={executingId === command.id}');
    expect(openClaude).toContain('aria-busy={dispatching}');
    expect(copyPrompt).toContain('aria-busy={copying}');
  });

  it('self-heals a missing HQ CLI instead of spawning a bare executable', () => {
    const packagesCommand = read('src-tauri/src/commands/packages.rs');
    const installed = read('src/desktop-alt/panels/InstalledPacksPanel.svelte');
    const settings = read('src/desktop-alt/pages/SettingsPage.svelte');
    const cliUpdate = read('src-tauri/src/commands/hq_cli_update.rs');
    const tauriMain = read('src-tauri/src/main.rs');

    expect(packagesCommand).toContain('fn resolve_packages_hq()');
    expect(packagesCommand).toContain('hq_resolver::HqInvocation::Local(local)');
    expect(packagesCommand).toContain('hq_resolver::resolve_hq()');
    expect(packagesCommand).toContain('npx_serial_guard().await');
    expect(installed).toContain('friendlyPackagesError(errorMsg)');
    expect(installed).toContain('copyRepairCommand');
    expect(installed).toContain('Copy install command');
    expect(installed).toContain('if (e.payload.error || !e.payload.packs)');
    expect(installed).toContain('aria-busy={refreshing}');
    expect(installed).toContain('const hasPackSnapshot');
    expect(installed).toContain('Installed packs unavailable');
    expect(installed).toContain('!hasPackSnapshot || isMissingPackagesToolError(errorMsg)');
    expect(installed).toContain('{:else if hasPackSnapshot}');
    expect(installed).not.toContain(
      "{errorContext === 'read'\n            ? 'The last successful installed-pack view is preserved.'",
    );
    expect(settings).toContain('data-testid="settings-cli-version"');
    expect(settings).toContain('data-testid="settings-cli-status"');
    expect(settings).toContain('data-testid="settings-check-cli-updates"');
    expect(cliUpdate).toContain('pub async fn get_hq_cli_version()');
    expect(tauriMain).toContain('commands::hq_cli_update::get_hq_cli_version');
  });

  it.skip('bounds the Messages rail while preserving explicit access to older conversations', () => {
    const messages = read('src/components/messaging/MessagesShell.svelte');
    expect(messages).toContain('const RAIL_RENDER_BATCH = 60');
    expect(messages).toContain('filteredRailItems.slice(0, railVisibleCount)');
    expect(messages).toContain('placeholder="Find a conversation"');
    expect(messages).toContain('Show {Math.min(RAIL_RENDER_BATCH, remainingRailItems)} more');
    expect(messages).toContain('aria-busy={isActive && loadingThread}');
    expect(messages).toContain('aria-current={isActive ? \'page\' : undefined}');
  });

  it('limits decorative hover motion to precise pointers and honors reduced motion', () => {
    const marketplace = read('src/desktop-alt/panels/MarketplacePanel.svelte');
    const company = read('src/desktop-alt/pages/CompanyPage.svelte');
    const projects = read('src/desktop-alt/components/ProjectRow.svelte');
    const library = read('src/desktop-alt/components/LibraryList.svelte');
    const emoji = read('src/components/messaging/EmojiPicker.svelte');
    const settings = read('src/desktop-alt/pages/SettingsPage.svelte');
    const widgetSettings = read('src/components/WidgetSettings.svelte');

    for (const source of [marketplace, company, projects, library, emoji]) {
      expect(source).toContain('@media (hover: hover) and (pointer: fine)');
    }
    expect(marketplace).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.card:hover \.cover-img[\s\S]*?transform: none/,
    );
    expect(emoji).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.emoji-cell:active[\s\S]*?transform: none/,
    );
    expect(settings).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?input\[type='checkbox'\]::after[\s\S]*?transition: none/,
    );
    expect(widgetSettings).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.toggle-knob[\s\S]*?transition: none/,
    );
  });

  it('keeps project navigation and goal linking as sibling native buttons', () => {
    const projects = read('src/desktop-alt/components/ProjectRow.svelte');
    expect(projects).toContain('class="project-open"');
    expect(projects).toMatch(
      /<\/button>\s*\{#if onlinkgoal && !goalLabel\}[\s\S]*?<button[\s\S]*?class="link-nudge"/,
    );
    expect(projects).not.toContain('role="button"');
  });
});
