import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LAST_PROJECT_KEY_PREFIX,
  STARTWORK_ENABLED_KEY,
  isStartworkTurn,
  lastProjectKey,
  planFirstSend,
  readLastProject,
  readStartworkEnabled,
  rememberLastProject,
  rememberStartworkEnabled,
  startworkCommand,
  startworkLabel,
  startworkLabelFromText,
  storyProgress,
} from './startwork';

describe('startworkCommand', () => {
  it('orients on the company when no project is chosen', () => {
    expect(startworkCommand({ company: 'indigo', project: null })).toBe('/startwork indigo');
  });

  it('lets a chosen project override the company', () => {
    expect(startworkCommand({ company: 'indigo', project: 'hq-desktop' })).toBe(
      '/startwork hq-desktop',
    );
  });

  it('has nothing to orient on without a company or a project', () => {
    expect(startworkCommand({ company: null, project: null })).toBeNull();
    expect(startworkCommand({ company: '  ', project: '' })).toBeNull();
  });
});

describe('isStartworkTurn', () => {
  it('recognises the command alone, with arguments, and with leading space', () => {
    expect(isStartworkTurn('/startwork')).toBe(true);
    expect(isStartworkTurn('/startwork indigo')).toBe(true);
    expect(isStartworkTurn('  /startwork indigo')).toBe(true);
  });

  it('does not match prose or a longer command name', () => {
    expect(isStartworkTurn('start work please')).toBe(false);
    expect(isStartworkTurn('/startworkflow')).toBe(false);
    expect(isStartworkTurn('/handoff')).toBe(false);
  });
});

describe('planFirstSend — the exact first-send sequence', () => {
  it('sends the hidden orientation turn, THEN the user text', () => {
    const plan = planFirstSend('fix the bug', { company: 'indigo', project: null }, true);
    expect(plan).toEqual([
      { text: '/startwork indigo', hidden: true, label: 'Starting work in indigo' },
      { text: 'fix the bug', hidden: false },
    ]);
  });

  it('uses the project when one is chosen and labels it', () => {
    const plan = planFirstSend('go', { company: 'indigo', project: 'sessions' }, true);
    expect(plan[0]).toEqual({
      text: '/startwork sessions',
      hidden: true,
      label: 'Starting work in indigo · project sessions',
    });
    expect(plan[1]).toEqual({ text: 'go', hidden: false });
  });

  it('respects the opt-out: one send, the text alone', () => {
    expect(planFirstSend('go', { company: 'indigo', project: null }, false)).toEqual([
      { text: 'go', hidden: false },
    ]);
  });

  it('never double-sends when the user typed /startwork themselves', () => {
    expect(planFirstSend('/startwork ridge', { company: 'indigo', project: null }, true)).toEqual([
      { text: '/startwork ridge', hidden: false },
    ]);
    expect(planFirstSend('  /startwork', { company: 'indigo', project: null }, true)).toHaveLength(1);
  });

  it('sends the text alone when there is no company to orient on', () => {
    expect(planFirstSend('go', { company: null, project: null }, true)).toEqual([
      { text: 'go', hidden: false },
    ]);
  });
});

describe('labels', () => {
  it('names company and project on the system line', () => {
    expect(startworkLabel({ company: 'indigo', project: null })).toBe('Starting work in indigo');
    expect(startworkLabel({ company: 'indigo', project: 'x' })).toBe(
      'Starting work in indigo · project x',
    );
    expect(startworkLabel({ company: null, project: null })).toBe('Starting work');
  });

  it('derives a label from a bare command once the mirror is gone', () => {
    expect(startworkLabelFromText('/startwork indigo')).toBe('Starting work in indigo');
    expect(startworkLabelFromText('/startwork')).toBe('Starting work');
  });

  it('formats story progress as done/total', () => {
    expect(storyProgress({ storyCounts: { total: 12, done: 3 } })).toBe('3/12');
  });
});

describe('persistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults the startwork toggle ON and persists only the opt-out', () => {
    expect(readStartworkEnabled()).toBe(true);
    rememberStartworkEnabled(false);
    expect(store.get(STARTWORK_ENABLED_KEY)).toBe('off');
    expect(readStartworkEnabled()).toBe(false);
    rememberStartworkEnabled(true);
    expect(store.has(STARTWORK_ENABLED_KEY)).toBe(false);
    expect(readStartworkEnabled()).toBe(true);
  });

  it('remembers the last project PER company under the agreed key', () => {
    expect(lastProjectKey('indigo')).toBe(`${LAST_PROJECT_KEY_PREFIX}indigo`);
    expect(lastProjectKey('indigo')).toBe('hq.sessions.lastProject.indigo');
    rememberLastProject('indigo', 'sessions');
    rememberLastProject('ridge', 'ads');
    expect(readLastProject('indigo')).toBe('sessions');
    expect(readLastProject('ridge')).toBe('ads');
    rememberLastProject('indigo', null);
    expect(readLastProject('indigo')).toBeNull();
    expect(readLastProject(null)).toBeNull();
  });
});
