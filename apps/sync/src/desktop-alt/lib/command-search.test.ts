import { describe, expect, it } from 'vitest';
import { rankCommands, scoreCommandMatch } from './command-search';

const commands = [
  { label: 'Search HQ', detail: 'Find knowledge and files', keywords: ['qmd'] },
  { label: 'Start work', detail: 'Open the HQ session router' },
  { label: 'Go to Indigo', detail: 'Show company overview' },
];

describe('command search', () => {
  it('prioritizes exact and prefix label matches', () => {
    expect(rankCommands(commands, 'start')[0]?.label).toBe('Start work');
    expect(scoreCommandMatch(commands[0], 'Search HQ')).toBe(0);
  });

  it('matches keywords and loose subsequences', () => {
    expect(rankCommands(commands, 'qmd')[0]?.label).toBe('Search HQ');
    expect(rankCommands(commands, 'gti')[0]?.label).toBe('Go to Indigo');
  });

  it('returns no results for unrelated text', () => {
    expect(rankCommands(commands, 'payroll')).toEqual([]);
  });
});
