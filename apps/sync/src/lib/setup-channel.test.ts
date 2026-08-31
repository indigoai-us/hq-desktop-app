import { describe, expect, it } from 'vitest';
import {
  SETUP_CHANNEL,
  SETUP_CHANNEL_ID,
  SETUP_LAUNCH_COMMANDS,
  SETUP_WELCOME_MESSAGES,
  isSetupChannel,
} from './setup-channel';

const TERMINAL_TOOL_ALLOWLIST = ['claude', 'codex', 'grok'] as const;

describe('SETUP_CHANNEL', () => {
  it('is a personal joined channel whose wire id is setup', () => {
    expect(SETUP_CHANNEL).toEqual({
      channelId: SETUP_CHANNEL_ID,
      name: 'setup',
      scope: 'personal',
      membership: 'joined',
    });
    expect(SETUP_CHANNEL.channelId).toBe('setup');
    expect(SETUP_CHANNEL_ID).toBe('setup');
  });
});

describe('isSetupChannel', () => {
  it('is true only for the setup channel id', () => {
    expect(isSetupChannel('setup')).toBe(true);
    expect(isSetupChannel(SETUP_CHANNEL_ID)).toBe(true);
    expect(isSetupChannel('general')).toBe(false);
    expect(isSetupChannel('')).toBe(false);
    expect(isSetupChannel(null)).toBe(false);
    expect(isSetupChannel(undefined)).toBe(false);
  });
});

describe('SETUP_LAUNCH_COMMANDS', () => {
  it('has exactly claude, codex, and grok keys', () => {
    expect(Object.keys(SETUP_LAUNCH_COMMANDS).sort()).toEqual([
      'claude',
      'codex',
      'grok',
    ]);
  });

  it("keeps grok's terminal tool inside the launch_cli_in_terminal allowlist", () => {
    expect(SETUP_LAUNCH_COMMANDS.grok.kind).toBe('terminal');
    expect(TERMINAL_TOOL_ALLOWLIST).toContain(SETUP_LAUNCH_COMMANDS.grok.tool);
  });
});

describe('SETUP_WELCOME_MESSAGES', () => {
  it('is a non-empty sequence that includes the HQ docs href', () => {
    expect(SETUP_WELCOME_MESSAGES.length).toBeGreaterThan(0);
    for (const message of SETUP_WELCOME_MESSAGES) {
      expect(message.id.trim().length).toBeGreaterThan(0);
      expect(message.body.trim().length).toBeGreaterThan(0);
    }
    const hrefs = SETUP_WELCOME_MESSAGES.flatMap((message) => message.links ?? []).map(
      (link) => link.href,
    );
    expect(hrefs).toContain('https://docs.getindigo.ai');
  });
});
