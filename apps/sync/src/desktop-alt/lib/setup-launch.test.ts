import { describe, expect, it } from 'vitest';

import { NO_AI_TOOLS, type AiTools } from '../../lib/onboarding-summary';
import {
  codexAvailable,
  resolveClaudeLaunchPath,
  resolveCodexLaunchPath,
  SETUP_PROMPT,
} from './setup-launch';

function tools(overrides: Partial<AiTools>): AiTools {
  return { ...NO_AI_TOOLS, ...overrides };
}

describe('resolveClaudeLaunchPath', () => {
  it('prefers the desktop deep link when Claude Code desktop is installed', () => {
    expect(
      resolveClaudeLaunchPath(tools({ claude_desktop: true, claude_cli: true })),
    ).toBe('deep-link');
  });

  it('falls back to the CLI when only claude_cli is detected', () => {
    expect(resolveClaudeLaunchPath(tools({ claude_cli: true }))).toBe('cli');
  });

  it('returns none when nothing is detected or probing failed', () => {
    expect(resolveClaudeLaunchPath(NO_AI_TOOLS)).toBe('none');
    expect(resolveClaudeLaunchPath(null)).toBe('none');
  });
});

describe('codexAvailable', () => {
  it('accepts the CLI or the desktop app (which bundles the CLI)', () => {
    expect(codexAvailable(tools({ codex_cli: true }))).toBe(true);
    // The ChatGPT app carries the codex CLI inside its bundle, so the
    // desktop app alone is launchable via `codex app <path>`.
    expect(codexAvailable(tools({ codex_desktop: true }))).toBe(true);
    expect(codexAvailable(tools({}))).toBe(false);
    expect(codexAvailable(null)).toBe(false);
  });
});

describe('resolveCodexLaunchPath', () => {
  it('prefers the ChatGPT desktop app when installed, even with a CLI', () => {
    expect(resolveCodexLaunchPath(tools({ codex_desktop: true, codex_cli: true }))).toBe('desktop');
    expect(resolveCodexLaunchPath(tools({ codex_desktop: true }))).toBe('desktop');
  });

  it('falls back to the terminal CLI when only codex_cli is detected', () => {
    expect(resolveCodexLaunchPath(tools({ codex_cli: true }))).toBe('cli');
  });

  it('returns none when nothing is detected or probing failed', () => {
    expect(resolveCodexLaunchPath(NO_AI_TOOLS)).toBe('none');
    expect(resolveCodexLaunchPath(null)).toBe('none');
  });
});

describe('SETUP_PROMPT', () => {
  it('matches the installer wizard prompt', () => {
    expect(SETUP_PROMPT).toBe('/setup');
  });
});
