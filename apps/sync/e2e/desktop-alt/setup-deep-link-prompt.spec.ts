import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Source contract for the four Claude Code DESKTOP DEEP LINK setup CTAs.
 *
 * The bug: every one of them pre-typed the bare `/setup` slash command into
 * the composer. Claude Desktop treats a folder handed to it by a `claude://`
 * link as untrusted and scans skills BEFORE the trust dialog is accepted, so
 * HQ's project skill under `.claude/skills/` is suppressed — Claude Code's
 * own wording is "skipped because this workspace was not trusted when
 * plugins were scanned. After accepting the trust dialog, run
 * /reload-plugins (or relaunch) to load what qualifies." The folder opened
 * correctly and `/setup` was pre-typed, but it was not a known command, so
 * the one-click setup CTA dead-ended.
 *
 * These are source assertions on purpose: the behaviour lives in Svelte
 * click handlers that no unit test mounts, and a call site can silently
 * regress to `'/setup'` without breaking anything else.
 *
 * TERMINAL launches (`launch_claude_code`, `launch_cli_in_terminal`) and the
 * clipboard fallback must KEEP `/setup` — trust is settled before the scan
 * there, so the slash command works.
 */
describe('Claude setup deep link carries a skill-independent prompt', () => {
  const wizard = readRepoFile('src/components/onboarding/OnboardingWizard.svelte');
  const card = readRepoFile('src/desktop-alt/components/SetupIncompleteCard.svelte');
  const launchLib = readRepoFile('src/desktop-alt/lib/setup-launch.ts');

  it('never hands the /setup slash command to buildClaudeCodeUrl', () => {
    for (const [name, source] of [
      ['OnboardingWizard.svelte', wizard],
      ['SetupIncompleteCard.svelte', card],
    ] as const) {
      const calls = source.match(/buildClaudeCodeUrl\(\{[\s\S]*?\}\)/g) ?? [];
      expect(calls.length, `${name} still builds a Claude deep link`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${name} deep link must not pre-type a slash command`).not.toMatch(
          /prompt:\s*(['"`]\/|SETUP_PROMPT\b)/,
        );
        expect(call, `${name} deep link must use the shared prompt`).toContain(
          'SETUP_DEEP_LINK_PROMPT',
        );
      }
    }
  });

  it('imports the prompt from the shared constant rather than inlining it', () => {
    expect(wizard).toContain("import { SETUP_DEEP_LINK_PROMPT } from '../../lib/setup-channel';");
    expect(card).toContain('SETUP_DEEP_LINK_PROMPT');
    // Re-exported (not redeclared) so the deep-link prompt has exactly one
    // definition across @hq/ui and this app.
    expect(launchLib).toContain("SETUP_DEEP_LINK_PROMPT");
    expect(launchLib).toContain("from '@hq/ui'");
    expect(launchLib).not.toContain('SETUP_DEEP_LINK_PROMPT =');
  });

  it('keeps /setup for terminal launches and the clipboard fallback', () => {
    expect(launchLib).toContain("export const SETUP_PROMPT = '/setup';");
    expect(card).toContain('navigator.clipboard.writeText(SETUP_PROMPT)');
    // Codex opens the workspace directly (`codex app <path>`), not through an
    // untrusted link folder, so its /setup prompt is deliberately unchanged.
    expect(card).toContain("prompt: '/setup',");
  });
});
