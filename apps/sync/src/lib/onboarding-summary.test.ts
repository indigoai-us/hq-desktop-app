import { describe, expect, it } from 'vitest';
import {
  NO_AI_TOOLS,
  markToolUnavailable,
  readyCommandFor,
  summaryLaunchState,
  type AiTools,
} from './onboarding-summary';

function tools(overrides: Partial<AiTools> = {}): AiTools {
  const merged = { ...NO_AI_TOOLS, ...overrides };
  return {
    ...merged,
    any:
      merged.claude_cli ||
      merged.claude_desktop ||
      merged.codex_cli ||
      merged.codex_desktop ||
      merged.grok_cli,
  };
}

describe('onboarding summary launch state', () => {
  it('prefers Claude Desktop over terminal CLIs', () => {
    expect(
      summaryLaunchState(
        tools({
          claude_desktop: true,
          claude_cli: true,
          codex_cli: true,
        }),
      ),
    ).toEqual({
      kind: 'claude-desktop',
      label: 'Launch Claude Desktop',
    });
  });

  it('offers Claude Code before Codex when both CLIs are installed', () => {
    expect(
      summaryLaunchState(
        tools({
          claude_cli: true,
          codex_cli: true,
        }),
      ),
    ).toEqual({
      kind: 'cli',
      label: 'Open Claude Code in Terminal',
      tool: 'claude',
    });
  });

  it('offers Codex CLI when Claude is absent', () => {
    expect(summaryLaunchState(tools({ codex_cli: true }))).toEqual({
      kind: 'cli',
      label: 'Open Codex CLI in Terminal',
      tool: 'codex',
    });
  });

  it('falls back to download when no supported AI tool is detected', () => {
    expect(summaryLaunchState(tools())).toEqual({
      kind: 'download',
      label: 'Download Claude',
    });
  });

  it('keeps a copy-command fallback for detected tools without a reusable launcher', () => {
    expect(summaryLaunchState(tools({ codex_desktop: true }))).toEqual({
      kind: 'copy-command',
      label: 'Copy command',
    });
  });
});

describe('onboarding summary ready command', () => {
  it('quotes the HQ path and runs the primary CLI when one is detected', () => {
    expect(
      readyCommandFor('/Users/me/HQ Workspace/$demo', tools({ codex_cli: true })),
    ).toBe('cd "/Users/me/HQ Workspace/\\$demo" && codex');
  });

  it('opens the folder directly when no terminal CLI is detected', () => {
    expect(readyCommandFor('/Users/me/hq', tools({ claude_desktop: true }))).toBe(
      'open "/Users/me/hq"',
    );
  });

  it('uses the shell-expandable default HQ folder when the path is unavailable', () => {
    expect(readyCommandFor(null, tools({ codex_cli: true }))).toBe(
      'cd ~/hq && codex',
    );
  });
});

describe('onboarding summary tool-state updates', () => {
  it('recomputes any when a failed Claude Desktop launch removes that tool', () => {
    expect(
      markToolUnavailable(
        tools({
          claude_desktop: true,
          codex_cli: true,
        }),
        'claude_desktop',
      ),
    ).toMatchObject({
      claude_desktop: false,
      codex_cli: true,
      any: true,
    });
  });

  it('clears any when the removed tool was the only detected option', () => {
    expect(markToolUnavailable(tools({ claude_desktop: true }), 'claude_desktop'))
      .toMatchObject({
        claude_desktop: false,
        any: false,
      });
  });
});
