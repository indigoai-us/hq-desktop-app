import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-012 — Open-in-Claude-Code across remaining surfaces.
 *
 * US-021 dropped ActivityPanel (activity drill-ins live in HQ Console). This
 * suite keeps the shared OpenFileInClaudeCode affordance + story-files wiring
 * green, and asserts the activity panel removal.
 */

describe('desktop-alt open-in-Claude-Code (US-012 / US-021)', () => {
  const affordance = readRepoFile(
    'src/desktop-alt/components/OpenFileInClaudeCode.svelte',
  );
  const openButton = readRepoFile('src/components/OpenInClaudeCodeButton.svelte');
  const appRs = readRepoFile('src-tauri/src/commands/app.rs');
  const panel = readRepoFile(
    'src/desktop-alt/components/StoryDetailPanel.svelte',
  );

  it('preflights Claude deep links against HQ root + hook health before dispatch', () => {
    expect(appRs).toContain('preflight_claude_code_url');
    expect(appRs).toContain('hq_desktop_core::claude_launch::preflight_claude_code_url');
  });

  it('prefixes OpenInClaudeCodeButton prompts with the bounded skill catalog', () => {
    expect(openButton).toContain(
      "import { buildClaudePromptWithSkillCatalog } from '../lib/skill-catalog-prompt'",
    );
    expect(openButton).toContain('buildClaudePromptWithSkillCatalog(basePrompt, companySlug)');
    expect(openButton).toContain("invoke<{ companySlug?: string | null }>('get_config')");
  });

  it('reuses the claude-code-link util + open_claude_code_link command (no reimplementation)', () => {
    expect(affordance).toContain(
      "import { buildClaudeCodeUrl } from '../../lib/claude-code-link'",
    );
    expect(affordance).toContain('buildClaudeCodeUrl({ folder, prompt })');
    expect(affordance).toContain("invoke('open_claude_code_link', { url })");
    expect(affordance).not.toContain("from '@tauri-apps/plugin-shell'");
    expect(affordance).not.toMatch(/claude:\/\/[\w/]*\?/);
    expect(affordance).toContain('{#if authorizedFile || folder}');
    expect(affordance).toContain(
      "invoke('open_authorized_file_in_claude', { path: file })",
    );
    expect(affordance).toContain(
      'Never fall back to a renderer-built prompt for an authorization',
    );
    expect(affordance).toContain('data-testid="open-in-claude-code"');
  });

  it('wires Open-in-Claude-Code into the story-files section (US-008 panel)', () => {
    expect(panel).toContain(
      "import OpenFileInClaudeCode from './OpenFileInClaudeCode.svelte'",
    );
    expect(panel).toContain('data-testid="story-files"');
    expect(panel).toContain('{#each files as file');
    expect(panel).toContain(
      '<OpenFileInClaudeCode {file} folder={hqFolderPath} variant="compact" />',
    );
    expect(panel).toContain("invoke<{ hqFolderPath?: string }>('get_config')");
  });

  it('no longer ships ActivityPanel activity drill-ins (US-021 console drop)', () => {
    expect(existsSync(join(process.cwd(), 'src/desktop-alt/panels/ActivityPanel.svelte'))).toBe(
      false,
    );
  });

  it('gives story-file surfaces consistent drill-in affordances', () => {
    const affordanceStyle = affordance.split('<style>')[1] ?? '';
    expect(affordanceStyle).toContain('cursor: pointer');
    expect(affordanceStyle).toContain('.open-claude-btn:hover');
    expect(affordanceStyle).toContain('.open-claude-btn:focus-visible');
    expect(affordanceStyle).toContain('outline: 2px solid var(--blue)');

    const panelStyle = panel.split('<style>')[1] ?? '';
    expect(panelStyle).toContain('.file-item:hover');
    expect(panelStyle).toContain(':focus-visible)');
  });

  it('keeps every US-012 surface token-driven (no hardcoded hex)', () => {
    for (const src of [affordance, panel]) {
      const styleBlock = src.split('<style>')[1] ?? '';
      expect(styleBlock).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
