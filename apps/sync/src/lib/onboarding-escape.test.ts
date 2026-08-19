import { describe, expect, it } from 'vitest';
import { escapeForLaunch, SETUP_NEEDS_PASS } from './onboarding-escape';

const SCREENSHOT_ERROR =
  'HQ folder is not ready for Claude Code Desktop setup repair (core/core.yaml (valid hq-core schema), companies/manifest.yaml) — re-tether in Settings or finish onboarding';

describe('onboarding escape paths', () => {
  it('turns the ready-screen Claude preflight failure into a folder next step', () => {
    const escape = escapeForLaunch('claude', SCREENSHOT_ERROR);
    expect(escape.kind).toBe('folder_not_ready');
    expect(escape.title).toMatch(/\/setup/);
    expect(JSON.stringify(escape)).not.toContain('core/core.yaml');
    expect(JSON.stringify(escape)).not.toContain('not ready');
    expect(JSON.stringify(escape)).not.toContain(SCREENSHOT_ERROR);
  });

  it('never echoes a raw backend string for any launch failure', () => {
    const raw = 'osascript failed (exit 1): execution error: Claude Code got an error';
    const escape = escapeForLaunch('claude', raw);
    expect(escape.kind).toBe('open_failed');
    expect(escape.body).not.toContain('osascript');
    expect(escape.body).not.toContain(raw);
  });

  it('points a missing tool at install-or-open-folder', () => {
    expect(escapeForLaunch('claude', 'Claude Code was not detected').kind).toBe(
      'tool_missing',
    );
    expect(escapeForLaunch('codex', 'Unable to find application').title).toContain(
      'Codex',
    );
  });

  it('gives reveal and download their own next steps', () => {
    expect(escapeForLaunch('folder', 'Could not reveal HQ folder: open exited 1').kind).toBe(
      'reveal_failed',
    );
    expect(escapeForLaunch('download', 'Failed to open url').kind).toBe(
      'download_failed',
    );
  });

  it('keeps the incomplete-setup caution free of error language', () => {
    expect(SETUP_NEEDS_PASS.body.toLowerCase()).not.toMatch(/error|failed|could not/);
    expect(SETUP_NEEDS_PASS.body).toMatch(/\/setup/);
  });
});
