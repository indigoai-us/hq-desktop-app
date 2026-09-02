import { describe, expect, it } from 'vitest';

import {
  applySlashCommand,
  filterSlashCommands,
  mergeSlashCommands,
  slashQueryFor,
} from './slash-commands';
import type { SessionCommand } from './session-events';

const command = (name: string, description = ''): SessionCommand => ({ name, description });

const CATALOG: SessionCommand[] = [
  command('handoff', 'End the session'),
  command('hq-share', 'Mint a share link'),
  command('learn', 'Capture a rule'),
  command('checkpoint', 'Checkpoint the session'),
];

describe('slashQueryFor', () => {
  it('reads a bare slash as an all-commands query', () => {
    expect(slashQueryFor('/')).toEqual({ prefix: '' });
  });

  it('lowercases the typed prefix', () => {
    expect(slashQueryFor('/HandOff')).toEqual({ prefix: 'handoff' });
  });

  it('tolerates leading whitespace', () => {
    expect(slashQueryFor('  /learn')).toEqual({ prefix: 'learn' });
  });

  it('is not a query once the user starts typing arguments', () => {
    expect(slashQueryFor('/hq-share some/path')).toBeNull();
  });

  it('is not a query for ordinary prose or an empty draft', () => {
    expect(slashQueryFor('run the tests')).toBeNull();
    expect(slashQueryFor('')).toBeNull();
  });
});

describe('filterSlashCommands', () => {
  it('returns nothing for a draft that is not a slash query', () => {
    expect(filterSlashCommands('hello', CATALOG)).toEqual([]);
  });

  it('offers the whole catalog for a bare slash', () => {
    expect(filterSlashCommands('/', CATALOG).map((c) => c.name)).toEqual([
      'handoff',
      'hq-share',
      'learn',
      'checkpoint',
    ]);
  });

  it('matches on the typed prefix, case-insensitively', () => {
    expect(filterSlashCommands('/HQ', CATALOG).map((c) => c.name)).toEqual(['hq-share']);
  });

  it('ranks prefix matches above substring matches', () => {
    const catalog = [command('checkpoint'), command('hand'), command('rehand')];
    expect(filterSlashCommands('/hand', catalog).map((c) => c.name)).toEqual(['hand', 'rehand']);
  });

  it('caps the offered list', () => {
    const many = Array.from({ length: 30 }, (_, i) => command(`cmd-${i}`));
    expect(filterSlashCommands('/cmd', many)).toHaveLength(8);
    expect(filterSlashCommands('/cmd', many, 3)).toHaveLength(3);
  });

  it('returns nothing when no command matches', () => {
    expect(filterSlashCommands('/zzz', CATALOG)).toEqual([]);
  });
});

describe('mergeSlashCommands', () => {
  it('prefers the richer primary entry but keeps names only the session knows', () => {
    const merged = mergeSlashCommands(
      [command('handoff', 'End the session')],
      [command('handoff', ''), command('session-only', '')],
    );
    expect(merged.map((c) => c.name)).toEqual(['handoff', 'session-only']);
    expect(merged[0]?.description).toBe('End the session');
  });

  it('never emits a duplicate name', () => {
    const merged = mergeSlashCommands(CATALOG, CATALOG);
    expect(new Set(merged.map((c) => c.name)).size).toBe(merged.length);
  });
});

describe('applySlashCommand', () => {
  it('replaces the typed token with the full name and a trailing space', () => {
    expect(applySlashCommand('/han', command('handoff'))).toBe('/handoff ');
  });

  it('preserves leading whitespace', () => {
    expect(applySlashCommand('  /han', command('handoff'))).toBe('  /handoff ');
  });
});
