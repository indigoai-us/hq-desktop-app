import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CHECKPOINT_COMMAND,
  HANDOFF_COMMAND,
  isCheckpointDirective,
  isCheckpointTurn,
  isHandoffTurn,
} from './hook-notices';

/** The banners exactly as HQ's hooks print them. */
const HQ_HOOKS = '/Users/jacobposel/Documents/HQ/.claude/hooks/';
function bannerOf(script: string): string | null {
  try {
    const source = readFileSync(`${HQ_HOOKS}${script}`, 'utf8');
    const start = source.indexOf("<<'BANNER_EOF'");
    const end = source.indexOf('BANNER_EOF', start + 20);
    return start === -1 || end === -1 ? null : source.slice(start + 14, end);
  } catch {
    return null;
  }
}

describe('isCheckpointDirective', () => {
  it('matches the 50% banner and the precompact banner verbatim', () => {
    expect(
      isCheckpointDirective('╔══╗\n║  AUTO-CHECKPOINT REQUIRED — context ~50%  ║\n╚══╝'),
    ).toBe(true);
    expect(isCheckpointDirective('AUTO-CHECKPOINT REQUIRED — precompact backup')).toBe(true);
  });

  it('matches the real banner text from HQ’s hooks when they are on this machine', () => {
    // Read straight from the scripts so a rewording there is caught here.
    // Skipped (never faked) when the HQ checkout is not present.
    for (const script of ['context-warning-50.sh', 'auto-checkpoint-precompact.sh']) {
      const banner = bannerOf(script);
      if (banner === null) continue;
      expect(isCheckpointDirective(banner), script).toBe(true);
    }
  });

  it('hedges on a reworded banner that still talks about context at 50%', () => {
    expect(isCheckpointDirective('Heads up: context is at 50% — checkpoint soon.')).toBe(true);
  });

  it('ignores ordinary hook context', () => {
    expect(isCheckpointDirective('<policy-reminder>\n> Policy `x` applies here: y\n')).toBe(false);
    expect(isCheckpointDirective('context: 50 items loaded')).toBe(false);
    expect(isCheckpointDirective('battery at 50%')).toBe(false);
  });
});

describe('slash-turn detection', () => {
  it('recognises the command as a whole word, with or without arguments', () => {
    expect(isHandoffTurn(HANDOFF_COMMAND)).toBe(true);
    expect(isHandoffTurn('  /handoff  ')).toBe(true);
    expect(isHandoffTurn('/handoff --quick')).toBe(true);
    expect(isHandoffTurn('/handoffs are great')).toBe(false);
    expect(isHandoffTurn('please /handoff')).toBe(false);
    expect(isCheckpointTurn(CHECKPOINT_COMMAND)).toBe(true);
    expect(isCheckpointTurn('/checkpoint now')).toBe(true);
    expect(isCheckpointTurn('/checkpoints')).toBe(false);
  });
});
