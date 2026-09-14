import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applySlashCommand,
  chipLabel,
  filterSlashCommands,
  kindLabel,
  mergeSlashCommands,
  PICKER_PAGE,
  recentRows,
  rowKind,
  SCOPE_FILTERS,
  scopeFilterMatches,
  replaceSlashQuery,
  slashQueryAt,
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

  it('reads the slash token at the end of ordinary prose', () => {
    expect(slashQueryFor('make a deck /ht')).toEqual({ prefix: 'ht' });
  });
});

describe('slashQueryAt', () => {
  it('finds a slash token at the caret anywhere in the draft', () => {
    expect(slashQueryAt('before /ht after', 10)).toEqual({
      start: 7,
      end: 10,
      prefix: 'ht',
    });
  });

  it('does not open inside a URL or an ordinary word', () => {
    expect(slashQueryAt('https://hq.com', 8)).toBeNull();
    expect(slashQueryAt('and/or', 6)).toBeNull();
  });

  it('replaces only the active token and reports the restored caret', () => {
    expect(replaceSlashQuery('before /ht after', { start: 7, end: 10 }, '')).toEqual({
      draft: 'before after',
      caret: 7,
    });
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

// ---------------------------------------------------------------------------
// The discovery picker's pure half
// ---------------------------------------------------------------------------

import {
  applyPickerRow,
  cliRows,
  filterRows,
  filterSkillRows,
  groupOptions,
  groupByScope,
  mergeSkillMetadata,
  pushRecentSlash,
  readRecentSlash,
  rememberRecentSlash,
  scopeLabel,
  scopeRank,
  serializeComposerRoute,
  skillRows,
  tagUnion,
  workerRows,
  workerSkillRows,
  type SkillCatalog,
} from './slash-commands';

const HQ_CATALOG: SkillCatalog = {
  workers: [
    {
      id: 'designer',
      name: 'Designer',
      description: 'Design work',
      company: null,
      skills: [
        { name: 'mockup', description: 'Draw a mockup', tags: ['design'], invoke: '/run designer mockup' },
        { name: 'critique', description: 'Critique a screen', tags: ['design', 'review'], invoke: '/run designer critique' },
      ],
    },
    { id: 'analyst', name: 'Analyst', description: 'Numbers', company: 'indigo', skills: [] },
  ],
  skills: [
    { name: 'handoff', description: 'End the session', scope: 'core', tags: ['session'], invoke: '/handoff' },
    { name: 'capture', description: 'Capture knowledge', scope: 'company:indigo', tags: ['knowledge'], invoke: '/indigo:capture' },
    { name: 'ads', description: 'Ridge ads', scope: 'company:ridge', tags: ['ads'], invoke: '/ridge:ads' },
    { name: 'dm', description: 'Send a DM', scope: 'personal', tags: ['session', 'people'], invoke: '/personal:dm' },
    { name: 'gws-gmail', description: 'Gmail', scope: 'package', tags: ['google'], invoke: '/gws-gmail' },
  ],
};

describe('picker rows', () => {
  it('orders skills company-first for the selected company, then personal, core, packages', () => {
    expect(skillRows(HQ_CATALOG, 'indigo').map((row) => row.name)).toEqual([
      '/indigo:capture',
      '/ridge:ads',
      '/personal:dm',
      '/handoff',
      '/gws-gmail',
    ]);
    expect(skillRows(HQ_CATALOG, 'ridge').map((row) => row.name)[0]).toBe('/ridge:ads');
    expect(scopeRank('company:indigo', 'indigo')).toBe(0);
    expect(scopeLabel('company:indigo')).toBe('indigo');
    expect(scopeLabel('package')).toBe('Packages');
    expect(skillRows(null, null)).toEqual([]);
  });

  it('inserts the real slash form with a trailing space', () => {
    const row = skillRows(HQ_CATALOG, 'indigo')[0]!;
    expect(row.insert).toBe('/indigo:capture ');
    expect(applyPickerRow('/cap', row)).toBe('/indigo:capture ');
    expect(applyPickerRow('  /cap', row)).toBe('  /indigo:capture ');
  });

  it('offers workers as drill-in rows and their skills as /run rows', () => {
    const workers = workerRows(HQ_CATALOG);
    expect(workers.map((row) => row.name)).toEqual(['Analyst', 'Designer']);
    expect(workers[1]?.insert).toBe('');
    expect(workers[1]?.workerId).toBe('designer');
    const skills = workerSkillRows(HQ_CATALOG.workers[0]!);
    expect(skills.map((row) => row.insert)).toEqual([
      '/run designer mockup ',
      '/run designer critique ',
    ]);
  });

  it('keeps only the CLI commands the HQ catalog does not already name', () => {
    const rows = cliRows(
      [
        { name: 'compact', description: 'Compact context' },
        { name: 'model', description: 'Pick a model', argumentHint: '[name]' },
        { name: 'handoff', description: 'CLI copy' },
      ],
      HQ_CATALOG,
    );
    expect(rows.map((row) => row.name)).toEqual(['/compact', '/model']);
    expect(rows[1]?.description).toBe('Pick a model [name]');
    expect(rows[1]?.insert).toBe('/model ');
  });

  it('filters across name, description and tags, prefix matches first', () => {
    const all = [...skillRows(HQ_CATALOG, 'indigo'), ...workerRows(HQ_CATALOG)];
    expect(filterRows(all, 'hand').map((row) => row.name)).toEqual(['/handoff']);
    // 'session' is a tag on /handoff and /personal:dm, a name match on neither.
    expect(filterRows(all, 'session').map((row) => row.name)).toEqual(['/personal:dm', '/handoff']);
    // Description hit.
    expect(filterRows(all, 'numbers').map((row) => row.name)).toEqual(['Analyst']);
    // Prefix beats substring: 'dm' starts /personal:dm? No — 'personal:dm' contains it.
    expect(filterRows(all, 'ridge').map((row) => row.name)).toEqual(['/ridge:ads']);
    expect(filterRows(all, '')).toHaveLength(all.length);
  });

  it('builds the tag row from the union, most common first', () => {
    expect(tagUnion(skillRows(HQ_CATALOG, 'indigo'))).toEqual(['session', 'ads', 'google', 'knowledge', 'people']);
    expect(tagUnion(skillRows(HQ_CATALOG, 'indigo'), 2)).toEqual(['session', 'ads']);
  });

  it('groups skills by scope in scope order', () => {
    const groups = groupByScope(skillRows(HQ_CATALOG, 'indigo'), 'indigo');
    expect(groups.map((group) => group.label)).toEqual(['indigo', 'ridge', 'Personal', 'Core', 'Packages']);
    expect(groups[0]?.rows.map((row) => row.name)).toEqual(['/indigo:capture']);
  });
});

describe('picker route contract', () => {
  it('keeps local tags for offline use and carries Console tags separately', () => {
    const merged = mergeSkillMetadata(HQ_CATALOG, [{
      skillUid: 'skl_capture', tags: ['shared'], groupId: 'grp_ops',
      groupName: 'Operations', companyWide: false,
    }]);
    // Fixture gains the stable id for this assertion only.
    const local = { ...HQ_CATALOG, skills: HQ_CATALOG.skills.map((skill) =>
      skill.invoke === '/indigo:capture' ? { ...skill, skillUid: 'skl_capture' } : skill) };
    const enriched = mergeSkillMetadata(local, [{ skillUid: 'skl_capture', tags: ['shared'], groupId: 'grp_ops', groupName: 'Operations', companyWide: false }]);
    expect(enriched.skills).toHaveLength(local.skills.length);
    expect(enriched.skills.find((skill) => skill.skillUid === 'skl_capture')).toMatchObject({
      tags: ['knowledge'], cloudTags: ['shared'], groupId: 'grp_ops', groupName: 'Operations', companyWide: false,
    });
    expect(merged.skills).toEqual(HQ_CATALOG.skills);
  });

  it('combines search, group, and tag filters with AND semantics', () => {
    const catalog: SkillCatalog = { ...HQ_CATALOG, skills: HQ_CATALOG.skills.map((skill) =>
      skill.invoke === '/indigo:capture' ? { ...skill, groupId: 'grp_ops', groupName: 'Operations', companyWide: false } : skill) };
    const rows = skillRows(catalog, 'indigo');
    expect(groupOptions(rows)).toEqual([{ id: 'grp_ops', name: 'Operations' }]);
    expect(filterSkillRows(rows, 'knowledge', 'grp_ops', 'knowledge').map((row) => row.name)).toEqual(['/indigo:capture']);
    expect(filterSkillRows(rows, '', 'grp_ops', 'people')).toEqual([]);
  });

  it('searches trigger phrases without exposing them as filter tags', () => {
    const rows = skillRows({
      workers: [],
      skills: [{
        name: 'Capture', description: 'Capture the screen', scope: 'company:indigo',
        tags: ['html'], searchTerms: ['always do this'], invoke: '/indigo:capture',
      }],
    }, 'indigo');
    expect(filterRows(rows, 'always do this').map((row) => row.name)).toEqual(['/indigo:capture']);
    expect(tagUnion(rows)).toEqual(['html']);
  });

  it('uses only Console tags when cloud taxonomy is available', () => {
    const rows = skillRows({
      workers: [],
      skills: [
        { name: 'Capture', description: '', scope: 'company:indigo', tags: ['local'], cloudTags: ['html'], invoke: '/indigo:capture' },
        { name: 'Handoff', description: '', scope: 'core', tags: ['session'], invoke: '/handoff' },
      ],
    }, 'indigo');
    expect(tagUnion(rows.filter((row) => row.scope === 'company:indigo'), 24, true)).toEqual(['html']);
    expect(filterSkillRows(rows, '', null, 'html', true).map((row) => row.name)).toEqual(['/indigo:capture']);
    expect(filterSkillRows(rows, '', null, 'local', true)).toEqual([]);
  });

  it('serializes skills and natural worker prompts exactly', () => {
    expect(serializeComposerRoute({ kind: 'skill', invoke: '/handoff', label: 'Handoff' }, '')).toBe('/handoff');
    expect(serializeComposerRoute({ kind: 'skill', invoke: '/capture', label: 'Capture' }, 'one thing')).toBe('/capture one thing');
    expect(serializeComposerRoute({ kind: 'worker', workerId: 'designer', label: 'Designer' }, 'Fix the flow')).toBe('/run designer -- Fix the flow');
  });
});

describe('recent picks', () => {
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

  it('keeps the last eight, most recent first, deduped by insert', () => {
    let recent = [] as ReturnType<typeof readRecentSlash>;
    for (let i = 0; i < 10; i += 1) {
      recent = pushRecentSlash(recent, { name: `/s${i}`, description: '', insert: `/s${i} ` });
    }
    expect(recent).toHaveLength(8);
    expect(recent[0]?.name).toBe('/s9');
    recent = pushRecentSlash(recent, { name: '/s5', description: 'again', insert: '/s5 ' });
    expect(recent[0]?.description).toBe('again');
    expect(recent.filter((entry) => entry.insert === '/s5 ')).toHaveLength(1);
    expect(recentRows(recent)[0]).toMatchObject({ group: 'recent', insert: '/s5 ', name: '/s5' });
  });

  it('round-trips through storage, infers a kind for older picks, and shrugs off garbage', () => {
    rememberRecentSlash([{ name: '/handoff', description: 'End', insert: '/handoff ', kind: 'skill' }]);
    expect(readRecentSlash()).toEqual([
      { name: '/handoff', description: 'End', insert: '/handoff ', kind: 'skill' },
    ]);
    store.set('hq.sessions.recentSlash', '{not json');
    expect(readRecentSlash()).toEqual([]);
    // Picks remembered before the kind pill existed: a `/run w s` is a worker
    // skill, anything else a skill; an unknown kind is treated the same way.
    store.set(
      'hq.sessions.recentSlash',
      JSON.stringify([
        { nope: 1 },
        { name: '/x', insert: '/x ' },
        { name: '/run design mockup', insert: '/run design mockup ' },
        { name: '/y', insert: '/y ', kind: 'bogus' },
      ]),
    );
    expect(readRecentSlash()).toEqual([
      { name: '/x', description: '', insert: '/x ', kind: 'skill' },
      { name: '/run design mockup', description: '', insert: '/run design mockup ', kind: 'worker-skill' },
      { name: '/y', description: '', insert: '/y ', kind: 'skill' },
    ]);
  });
});

describe('kind pills and the command chip', () => {
  it('names every row kind, and recent rows carry theirs', () => {
    expect(rowKind({ group: 'workers', insert: '', workerId: 'design' })).toBe('worker');
    expect(rowKind({ group: 'workers', insert: '/run design mockup ', workerId: 'design' })).toBe('worker-skill');
    expect(rowKind({ group: 'skills', insert: '/handoff ' })).toBe('skill');
    expect(rowKind({ group: 'cli', insert: '/model ' })).toBe('cli');
    expect(rowKind({ group: 'recent', insert: '/model ', kind: 'cli' })).toBe('cli');
    expect(rowKind({ group: 'recent', insert: '/run a b ' })).toBe('worker-skill');
    expect(rowKind({ group: 'recent', insert: '/handoff ' })).toBe('skill');
    expect(recentRows([{ name: '/model', description: '', insert: '/model ', kind: 'cli' }])[0]?.kind).toBe('cli');
  });

  it('labels kinds in plain words', () => {
    expect(kindLabel('worker')).toBe('worker');
    expect(kindLabel('worker-skill')).toBe('worker skill');
    expect(kindLabel('skill')).toBe('skill');
    expect(kindLabel('cli')).toBe('command');
  });

  it('the chip names a worker skill as `worker · skill` and anything else by its command', () => {
    expect(chipLabel('/run design mockup ', 'worker-skill')).toBe('design · mockup');
    expect(chipLabel('/handoff ', 'skill')).toBe('/handoff');
    expect(chipLabel('/model ', 'cli')).toBe('/model');
    // A malformed worker-skill insert falls back to the literal token.
    expect(chipLabel('/run design ', 'worker-skill')).toBe('/run design');
  });

  it('scope chips: Company means any company scope; the rest match exactly', () => {
    expect(SCOPE_FILTERS.map((entry) => entry.id)).toEqual(['company', 'personal', 'core', 'package']);
    expect(scopeFilterMatches({ scope: 'company:indigo' }, 'company')).toBe(true);
    expect(scopeFilterMatches({ scope: 'company:ridge' }, 'company')).toBe(true);
    expect(scopeFilterMatches({ scope: 'core' }, 'company')).toBe(false);
    expect(scopeFilterMatches({ scope: 'personal' }, 'personal')).toBe(true);
    expect(scopeFilterMatches({ scope: 'package' }, 'package')).toBe(true);
    expect(scopeFilterMatches({ scope: undefined }, 'core')).toBe(true);
    expect(scopeFilterMatches({ scope: 'core' }, null)).toBe(true);
  });

  it('caps each group at eight rows before "more…"', () => {
    expect(PICKER_PAGE).toBe(8);
  });
});
