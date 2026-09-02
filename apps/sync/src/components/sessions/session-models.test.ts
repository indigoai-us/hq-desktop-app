// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EFFORT_OPTIONS,
  FALLBACK_MODELS,
  LAST_MODEL_KEY,
  LAST_TOOL_KEY,
  TOOL_OPTIONS,
  defaultModelHint,
  firstSentence,
  friendlyModelName,
  modelPillLabel,
  modelRowLabel,
  pickModel,
  readRemembered,
  readRememberedTool,
  readSessionModels,
  remember,
  selectableModels,
  shortenModelLabel,
} from './session-models';

/** The exact shape the CLI handshake sends, verified against the real probe. */
const REAL_CATALOG = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Use the default model (currently Opus 5 (1M context))',
  },
  { value: 'opus[1m]', displayName: 'Opus (1M context)' },
  { value: 'claude-fable-5-1[1m]', displayName: 'Fable' },
  { value: 'sonnet', displayName: 'Sonnet' },
  { value: 'haiku', displayName: 'Haiku' },
];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('readSessionModels — the real catalog', () => {
  it('labels every row by displayName', () => {
    expect(readSessionModels(REAL_CATALOG).map((m) => m.label)).toEqual([
      'Default',
      'Opus (1M context)',
      'Fable',
      'Sonnet',
      'Haiku',
    ]);
  });

  it('sends `value` as the model id — never the display name', () => {
    const fable = readSessionModels(REAL_CATALOG).find((m) => m.label === 'Fable');
    expect(fable?.value).toBe('claude-fable-5-1[1m]');
  });

  it('translates "default" into "omit the model field entirely"', () => {
    // Sending the literal string "default" would be naming a model the CLI has
    // never heard of; the spec's `model` is optional for exactly this reason.
    const [first] = readSessionModels(REAL_CATALOG);
    expect(first?.label).toBe('Default');
    expect(first?.value).toBeNull();
  });

  it('keeps the description when the CLI supplies one', () => {
    expect(readSessionModels(REAL_CATALOG)[0]?.description).toContain('default model');
  });
});

describe('readSessionModels — defensiveness', () => {
  it('falls back when the probe returns nothing', () => {
    expect(readSessionModels([])).toEqual(FALLBACK_MODELS);
  });

  it('falls back when nothing in the payload is recognisable', () => {
    expect(readSessionModels([42, null, {}, { nope: 'x' }])).toEqual(FALLBACK_MODELS);
  });

  it('offers only real CLI aliases in the fallback', () => {
    expect(FALLBACK_MODELS.map((m) => m.value)).toEqual([null, 'opus', 'sonnet', 'haiku']);
  });

  it('accepts a bare string list', () => {
    expect(readSessionModels(['opus', 'sonnet'])).toEqual([
      { value: 'opus', label: 'opus' },
      { value: 'sonnet', label: 'sonnet' },
    ]);
  });

  it('reads the older id/name key spellings', () => {
    expect(readSessionModels([{ id: 'opus', name: 'Opus' }])[0]).toEqual({
      value: 'opus',
      label: 'Opus',
      description: undefined,
    });
  });

  it('drops duplicates rather than repeating a pill', () => {
    expect(
      readSessionModels([{ value: 'opus' }, { value: 'opus', displayName: 'Opus again' }]),
    ).toHaveLength(1);
  });

  it('never yields a label that would render as [object Object]', () => {
    for (const model of readSessionModels([{ value: 'x', displayName: undefined }])) {
      expect(typeof model.label).toBe('string');
      expect(model.label).not.toContain('object Object');
    }
  });
});

describe('shortenModelLabel', () => {
  it('drops the parenthetical a pill has no room for', () => {
    expect(shortenModelLabel('Default (recommended)')).toBe('Default');
  });

  it('leaves a meaningful parenthetical alone', () => {
    expect(shortenModelLabel('Opus (1M context)')).toBe('Opus (1M context)');
  });
});

describe('pickModel', () => {
  const models = readSessionModels(REAL_CATALOG);

  it('restores the remembered choice', () => {
    expect(pickModel(models, 'claude-fable-5-1[1m]')?.label).toBe('Fable');
  });

  it('falls to the catalog default when the remembered model is gone', () => {
    expect(pickModel(models, 'a-model-that-retired')?.label).toBe('Default');
  });

  it('defaults to the first entry when nothing is remembered', () => {
    expect(pickModel(models, null)?.label).toBe('Default');
  });

  it('has no answer for an empty catalog', () => {
    expect(pickModel([], 'opus')).toBeNull();
  });
});

describe('effort options', () => {
  it('offers exactly the CLI’s effort levels, plus "omit it"', () => {
    expect(EFFORT_OPTIONS.map((option) => option.value)).toEqual([
      null,
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(EFFORT_OPTIONS[0]?.label).toBe('Auto');
  });
});

describe('remembering pill choices', () => {
  it('round-trips a value', () => {
    remember(LAST_MODEL_KEY, 'opus');
    expect(readRemembered(LAST_MODEL_KEY)).toBe('opus');
  });

  it('forgets rather than storing the implicit choice', () => {
    remember(LAST_MODEL_KEY, 'opus');
    remember(LAST_MODEL_KEY, null);
    expect(readRemembered(LAST_MODEL_KEY)).toBeNull();
  });

  it('reads as "nothing remembered" when storage throws', () => {
    // Private mode, a disabled origin — a lost preference must never be the
    // thing that stops a session from starting.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(readRemembered(LAST_MODEL_KEY)).toBeNull();
  });

  it('swallows a write that storage refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => remember(LAST_MODEL_KEY, 'opus')).not.toThrow();
  });
});

describe('friendlyModelName — an id is not a name', () => {
  it.each([
    ['claude-opus-4-8', 'Opus 4.8'],
    ['claude-fable-5-1[1m]', 'Fable 5.1'],
    ['claude-sonnet-4-6', 'Sonnet 4.6'],
    ['claude-haiku-4-5-20260101', 'Haiku 4.5'],
    ['claude-opus-5[1m]', 'Opus 5'],
    ['opus[1m]', 'Opus (1M)'],
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet'],
    ['haiku', 'Haiku'],
  ])('%s → %s', (id, expected) => {
    expect(friendlyModelName(id)).toBe(expected);
  });

  it('drops a build stamp rather than reading it as a version', () => {
    // `4-5-20260101` is Haiku 4.5 built on a date, not Haiku 4.5.20260101.
    expect(friendlyModelName('claude-haiku-4-5-20260101')).not.toContain('2026');
  });

  it('speaks the context window only when nothing else disambiguates', () => {
    // `opus` and `opus[1m]` are two rows in one menu; `claude-fable-5-1[1m]`
    // has no sibling it could be confused with.
    expect(friendlyModelName('opus[1m]')).toBe('Opus (1M)');
    expect(friendlyModelName('claude-fable-5-1[1m]')).toBe('Fable 5.1');
  });

  it('title-cases an unknown family and keeps acronyms upper', () => {
    expect(friendlyModelName('claude-newfamily-6-2')).toBe('Newfamily 6.2');
    expect(friendlyModelName('gpt-5')).toBe('GPT 5');
  });

  it('strips a bedrock-style region prefix', () => {
    expect(friendlyModelName('us.anthropic.claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('has no answer for nothing, and says so rather than guessing', () => {
    expect(friendlyModelName(null)).toBe('');
    expect(friendlyModelName('')).toBe('');
    expect(friendlyModelName('   ')).toBe('');
  });
});

describe('defaultModelHint', () => {
  it('reads the model the CLI says it is currently defaulting to', () => {
    expect(
      defaultModelHint('Use the default model (currently Opus 5 (1M context))'),
    ).toBe('Opus 5');
  });

  it('is empty when the description names nothing', () => {
    expect(defaultModelHint('Use the default model')).toBe('');
    expect(defaultModelHint(undefined)).toBe('');
  });
});

describe('firstSentence', () => {
  it('takes one sentence, not the paragraph', () => {
    expect(firstSentence('Most capable for your hardest tasks. Slower and pricier.')).toBe(
      'Most capable for your hardest tasks',
    );
  });

  it('leaves an unpunctuated line whole', () => {
    expect(firstSentence('Most capable for your hardest and longest-running tasks')).toBe(
      'Most capable for your hardest and longest-running tasks',
    );
  });

  it('is empty for nothing', () => {
    expect(firstSentence(undefined)).toBe('');
  });
});

describe('the model menu', () => {
  const models = readSessionModels(REAL_CATALOG);

  it('offers no "Default" row — that is an un-choice, not a choice', () => {
    expect(selectableModels(models).some((entry) => entry.value === null)).toBe(false);
    expect(selectableModels(models)).toHaveLength(models.length - 1);
  });

  it('labels each row from its id, not the CLI’s terse display name', () => {
    expect(selectableModels(models).map(modelRowLabel)).toEqual([
      'Opus (1M)',
      'Fable 5.1',
      'Sonnet',
      'Haiku',
    ]);
  });
});

describe('modelPillLabel — never a raw id, never "Default"', () => {
  const models = readSessionModels(REAL_CATALOG);

  it('names an explicit choice', () => {
    expect(modelPillLabel(models, 'claude-fable-5-1[1m]')).toBe('Fable 5.1');
  });

  it('names the model the live session actually resolved', () => {
    expect(modelPillLabel(models, null, 'claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('falls back to the catalog’s own hint before a session exists', () => {
    expect(modelPillLabel(models, null, null)).toBe('Opus 5');
  });

  it('says "Recommended" only when the catalog explains nothing', () => {
    expect(modelPillLabel(FALLBACK_MODELS, null, null)).toBe('Recommended');
  });
});

describe('the tool pill', () => {
  it('offers exactly Claude and Codex', () => {
    expect(TOOL_OPTIONS.map((option) => option.value)).toEqual(['claude', 'codex']);
    expect(TOOL_OPTIONS.map((option) => option.label)).toEqual(['Claude', 'Codex']);
  });

  it('remembers the last tool under the agreed key', () => {
    expect(LAST_TOOL_KEY).toBe('hq.sessions.lastTool');
    remember(LAST_TOOL_KEY, 'codex');
    expect(readRememberedTool()).toBe('codex');
  });

  it('defaults to the only CLI that always exists', () => {
    expect(readRememberedTool()).toBe('claude');
    remember(LAST_TOOL_KEY, 'nonsense');
    expect(readRememberedTool()).toBe('claude');
  });
});
