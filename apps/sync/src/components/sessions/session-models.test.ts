// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CLAUDE_EFFORT_OPTIONS,
  CODEX_EFFORT_OPTIONS,
  EFFORT_OPTIONS,
  FALLBACK_CODEX_MODELS,
  FALLBACK_MODELS,
  LAST_EFFORT_KEY,
  LAST_MODEL_KEY,
  LAST_TOOL_KEY,
  TOOL_OPTIONS,
  clampEffort,
  defaultModelHint,
  effortOptionsFor,
  fallbackModelsFor,
  firstSentence,
  friendlyModelName,
  isFallbackCatalog,
  lastEffortKey,
  lastModelKey,
  modelMenuRows,
  modelPillLabel,
  modelRowLabel,
  pickModel,
  plausibleModelForTool,
  readRemembered,
  readRememberedEffort,
  readRememberedModel,
  readRememberedTool,
  readSessionModels,
  remember,
  rememberEffort,
  rememberModel,
  selectableModels,
  shortenModelLabel,
  validateModel,
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

/**
 * Codex's `model/list` result, as `parse_model_list` hands it to the composer.
 * Recorded against codex-cli 0.144.1 (see the spike's FINDINGS-codex.md §6):
 * several distinct models share a version, and only `displayName` tells them
 * apart — the ids differ in exactly the segment the friendly mapper drops.
 */
const CODEX_CATALOG = [
  {
    value: 'gpt-5.6-sol',
    displayName: 'GPT-5.6-Sol',
    description: 'Balanced reasoning for everyday work.',
    supportedReasoningEfforts: [
      { reasoningEffort: 'low' },
      { reasoningEffort: 'medium' },
      { reasoningEffort: 'high' },
    ],
    defaultReasoningEffort: 'medium',
  },
  { value: 'gpt-5.6-codex', displayName: 'GPT-5.6-Codex' },
  { value: 'gpt-5.6-codex-mini', displayName: 'GPT-5.6-Codex-Mini' },
  { value: 'gpt-5.4-sol', displayName: 'GPT-5.4-Sol' },
  { value: 'gpt-5.4-codex', displayName: 'GPT-5.4-Codex' },
];

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('readSessionModels — the real catalog', () => {
  it('uses readable qualifiers for resolved default and explicit context aliases', () => {
    const rows = modelMenuRows(readSessionModels([
      { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5' },
      { value: 'opus[1m]', displayName: 'Opus', resolvedModel: 'claude-opus-5' },
    ]));
    expect(rows.map(row => row.label)).toEqual(['Opus 5 (recommended)', 'Opus 5 (1M context)']);
    expect(rows.map(row => row.value)).toEqual([null, 'opus[1m]']);
  });
  it('offers the resolved default as a versioned choice when the provider only exposes that alias', () => {
    const models = readSessionModels([{ value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5[1m]' }]);
    expect(modelPillLabel(models, null)).toBe('Opus 5');
    expect(modelMenuRows(models)).toEqual([expect.objectContaining({ value: null, label: 'Opus 5' })]);
  });
  it('shows the live resolved version for a provider alias while preserving its launch value', () => {
    const [entry] = readSessionModels([{ value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' }]);
    expect(entry.value).toBe('sonnet');
    expect(modelRowLabel(entry, 'claude')).toBe('Sonnet 5');
  });
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
    expect(selectableModels(models).map((entry) => modelRowLabel(entry))).toEqual([
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

describe('the Codex model menu names every model, and names it once', () => {
  const models = readSessionModels(CODEX_CATALOG);

  it('reads Codex ids as distinct models rather than one version', () => {
    // The bug: `friendlyModelName` drops everything after the version, so five
    // distinct ids rendered as "GPT 5.6" ×3 and "GPT 5.4" ×2.
    expect(models.map((entry) => friendlyModelName(entry.value))).toEqual([
      'GPT 5.6',
      'GPT 5.6',
      'GPT 5.6',
      'GPT 5.4',
      'GPT 5.4',
    ]);
    expect(modelMenuRows(models, 'codex').map((row) => row.label)).toEqual([
      'GPT-5.6-Sol',
      'GPT-5.6-Codex',
      'GPT-5.6-Codex-Mini',
      'GPT-5.4-Sol',
      'GPT-5.4-Codex',
    ]);
  });

  it('never renders the same words twice', () => {
    const labels = modelMenuRows(models, 'codex').map((row) => row.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps every row addressable by its own id', () => {
    expect(modelMenuRows(models, 'codex').map((row) => row.value)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-codex',
      'gpt-5.6-codex-mini',
      'gpt-5.4-sol',
      'gpt-5.4-codex',
    ]);
  });

  it('drops a duplicate id rather than offering the same choice twice', () => {
    const dupes = readSessionModels([
      { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
      { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol (again)' },
    ]);
    expect(modelMenuRows(dupes, 'codex')).toHaveLength(1);
  });

  it('disambiguates two ids that really do share a display name', () => {
    const colliding = readSessionModels([
      { value: 'gpt-5.6-sol', displayName: 'GPT-5.6' },
      { value: 'gpt-5.6-codex-mini', displayName: 'GPT-5.6' },
    ]);
    expect(modelMenuRows(colliding, 'codex').map((row) => row.label)).toEqual([
      'GPT-5.6 (sol)',
      'GPT-5.6 (codex-mini)',
    ]);
  });

  it('falls back to the friendly mapper only when there is no display name', () => {
    const bare = readSessionModels([{ value: 'gpt-5.6-sol' }]);
    expect(modelRowLabel(bare[0]!, 'codex')).toBe('GPT 5.6');
  });

  it('leaves Claude naming models from their ids', () => {
    const claude = readSessionModels(REAL_CATALOG);
    expect(modelMenuRows(claude, 'claude').map((row) => row.label)).toEqual([
      'Opus (1M)',
      'Fable 5.1',
      'Sonnet',
      'Haiku',
    ]);
  });
});

describe('the pill and the strip name a Codex model the way the menu does', () => {
  const models = readSessionModels(CODEX_CATALOG);

  it('names an explicit Codex choice by its display name', () => {
    expect(modelPillLabel(models, 'gpt-5.6-codex', null, 'codex')).toBe('GPT-5.6-Codex');
    // Without the tool the same id collapses to its version — the old bug.
    expect(modelPillLabel(models, 'gpt-5.6-codex')).toBe('GPT 5.6');
  });

  it('names the model a live Codex session resolved', () => {
    expect(modelPillLabel(models, null, 'gpt-5.6-codex-mini', 'codex')).toBe(
      'GPT-5.6-Codex-Mini',
    );
  });

  it('still says something honest for a model the catalog has never heard of', () => {
    expect(modelPillLabel(models, 'gpt-9-experimental', null, 'codex')).toBe('GPT 9');
    expect(modelPillLabel([], null, 'gpt-5.6-codex', 'codex')).toBe('GPT 5.6');
  });
});

// ---------------------------------------------------------------------------
// The bug: one model memory shared by two CLIs
// ---------------------------------------------------------------------------

describe('the model is remembered per tool', () => {
  it('keys each CLI’s memory under its own name', () => {
    expect(lastModelKey('claude')).toBe('hq.sessions.lastModel.claude');
    expect(lastModelKey('codex')).toBe('hq.sessions.lastModel.codex');
    expect(lastEffortKey('claude')).toBe('hq.sessions.lastEffort.claude');
    expect(lastEffortKey('codex')).toBe('hq.sessions.lastEffort.codex');
  });

  it('never hands one CLI the other’s choice', () => {
    // The owner's screenshot: a Codex session's `gpt-5.6-sol` was read back
    // for the next Claude session and rejected on every turn.
    rememberModel('codex', 'gpt-5.6-sol');
    expect(readRememberedModel('codex')).toBe('gpt-5.6-sol');
    expect(readRememberedModel('claude')).toBeNull();

    rememberModel('claude', 'claude-fable-5-1[1m]');
    expect(readRememberedModel('claude')).toBe('claude-fable-5-1[1m]');
    expect(readRememberedModel('codex')).toBe('gpt-5.6-sol');
  });

  it('forgets a tool’s choice without touching the other tool’s', () => {
    rememberModel('codex', 'gpt-5.6-sol');
    rememberModel('claude', 'sonnet');
    rememberModel('claude', null);
    expect(readRememberedModel('claude')).toBeNull();
    expect(readRememberedModel('codex')).toBe('gpt-5.6-sol');
  });

  it('migrates the pre-per-tool key into the CURRENT tool, once', () => {
    remember(LAST_MODEL_KEY, 'gpt-5.6-sol');
    // The tool that is current when the legacy value is first read inherits it…
    expect(readRememberedModel('codex')).toBe('gpt-5.6-sol');
    expect(readRemembered(lastModelKey('codex'))).toBe('gpt-5.6-sol');
    // …the legacy key is gone…
    expect(readRemembered(LAST_MODEL_KEY)).toBeNull();
    // …so the other tool does NOT inherit it too.
    expect(readRememberedModel('claude')).toBeNull();
  });

  it('prefers a tool’s own memory over a legacy value', () => {
    remember(LAST_MODEL_KEY, 'gpt-5.6-sol');
    rememberModel('claude', 'sonnet');
    expect(readRememberedModel('claude')).toBe('sonnet');
    // The legacy value is still waiting for whichever tool reads it first.
    expect(readRemembered(LAST_MODEL_KEY)).toBe('gpt-5.6-sol');
  });

  it('remembers effort per tool, with the same migration', () => {
    remember(LAST_EFFORT_KEY, 'xhigh');
    expect(readRememberedEffort('codex')).toBe('xhigh');
    expect(readRemembered(LAST_EFFORT_KEY)).toBeNull();
    expect(readRememberedEffort('claude')).toBeNull();
    rememberEffort('claude', 'max');
    expect(readRememberedEffort('claude')).toBe('max');
    expect(readRememberedEffort('codex')).toBe('xhigh');
  });
});

describe('plausibleModelForTool — the pre-catalog check', () => {
  it.each([
    'default',
    'opus',
    'sonnet',
    'haiku',
    'fable',
    'opus[1m]',
    'claude-fable-5-1[1m]',
    'claude-opus-4-8',
    'us.anthropic.claude-opus-4-8',
  ])('lets Claude carry %s', (id) => {
    expect(plausibleModelForTool(id, 'claude')).toBe(true);
  });

  it.each(['gpt-5.6-sol', 'gpt-5.6-codex-mini', 'o3', 'o4-mini'])('lets Codex carry %s', (id) => {
    expect(plausibleModelForTool(id, 'codex')).toBe(true);
  });

  it('never lets Claude carry a Codex id, nor Codex a Claude one', () => {
    expect(plausibleModelForTool('gpt-5.6-sol', 'claude')).toBe(false);
    expect(plausibleModelForTool('o3', 'claude')).toBe(false);
    expect(plausibleModelForTool('opus', 'codex')).toBe(false);
    expect(plausibleModelForTool('claude-fable-5-1[1m]', 'codex')).toBe(false);
  });

  it('treats Default (no model) as always fine, and an empty id as never', () => {
    expect(plausibleModelForTool(null, 'claude')).toBe(true);
    expect(plausibleModelForTool(null, 'codex')).toBe(true);
    expect(plausibleModelForTool('', 'claude')).toBe(false);
    expect(plausibleModelForTool('   ', 'codex')).toBe(false);
  });
});

describe('validateModel — a spec never carries a model its CLI lacks', () => {
  const claude = readSessionModels(REAL_CATALOG);
  const codex = readSessionModels(CODEX_CATALOG, 'codex');

  it('keeps a model the loaded catalog offers', () => {
    expect(validateModel('claude-fable-5-1[1m]', 'claude', claude)).toEqual({
      model: 'claude-fable-5-1[1m]',
      reset: false,
    });
    expect(validateModel('gpt-5.6-sol', 'codex', codex)).toEqual({
      model: 'gpt-5.6-sol',
      reset: false,
    });
  });

  it('resets a model the loaded catalog does not offer — the owner’s bug', () => {
    expect(validateModel('gpt-5.6-sol', 'claude', claude)).toEqual({ model: null, reset: true });
    expect(validateModel('claude-fable-5-1[1m]', 'codex', codex)).toEqual({
      model: null,
      reset: true,
    });
  });

  it('with the catalog loaded, even a real alias must be a row', () => {
    // `opus` is a CLI alias but not a row of this catalog (`opus[1m]` is).
    expect(validateModel('opus', 'claude', claude).reset).toBe(true);
  });

  it('without a catalog, trusts only the CLI’s own aliases', () => {
    expect(validateModel('opus', 'claude', null)).toEqual({ model: 'opus', reset: false });
    expect(validateModel('claude-opus-4-8', 'claude', null).reset).toBe(false);
    expect(validateModel('gpt-5.6-sol', 'claude', null)).toEqual({ model: null, reset: true });
    expect(validateModel('gpt-5.6-sol', 'codex', null).reset).toBe(false);
    expect(validateModel('opus', 'codex', null).reset).toBe(true);
  });

  it('treats an empty catalog like no catalog', () => {
    expect(validateModel('opus', 'claude', []).reset).toBe(false);
  });

  it('never resets Default', () => {
    expect(validateModel(null, 'claude', claude)).toEqual({ model: null, reset: false });
    expect(validateModel(null, 'codex', null)).toEqual({ model: null, reset: false });
  });
});

describe('the fallback catalog is per tool, and is not a catalog', () => {
  it('offers Codex only Default — no Claude aliases', () => {
    expect(FALLBACK_CODEX_MODELS.map((m) => m.value)).toEqual([null]);
    expect(readSessionModels([], 'codex')).toEqual(FALLBACK_CODEX_MODELS);
    expect(readSessionModels([], 'claude')).toEqual(FALLBACK_MODELS);
    expect(fallbackModelsFor('codex')).toEqual(FALLBACK_CODEX_MODELS);
  });

  it('recognises its own fallback so nothing is validated against it', () => {
    expect(isFallbackCatalog(readSessionModels([], 'claude'), 'claude')).toBe(true);
    expect(isFallbackCatalog(readSessionModels([], 'codex'), 'codex')).toBe(true);
    expect(isFallbackCatalog(readSessionModels(REAL_CATALOG), 'claude')).toBe(false);
    expect(isFallbackCatalog(readSessionModels(CODEX_CATALOG, 'codex'), 'codex')).toBe(false);
  });
});

describe('the effort ladder is per tool', () => {
  it('leaves EFFORT_OPTIONS as Claude’s ladder', () => {
    expect(CLAUDE_EFFORT_OPTIONS).toBe(EFFORT_OPTIONS);
    expect(effortOptionsFor('claude')).toEqual(EFFORT_OPTIONS);
  });

  it('offers Codex its own rungs — xhigh and ultra, never max', () => {
    const values = CODEX_EFFORT_OPTIONS.map((option) => option.value);
    expect(values).toEqual([null, 'low', 'medium', 'high', 'xhigh', 'ultra']);
    expect(effortOptionsFor('codex')).toEqual(CODEX_EFFORT_OPTIONS);
    expect(CODEX_EFFORT_OPTIONS.find((option) => option.value === 'xhigh')?.label).toBe(
      'Extra high',
    );
  });

  it('reads the ladder off the catalog when the rows declare one', () => {
    // Codex: `supportedReasoningEfforts: [{ reasoningEffort }]` on the row.
    const codex = readSessionModels(CODEX_CATALOG, 'codex');
    expect(codex[0]?.efforts).toEqual(['low', 'medium', 'high']);
    expect(effortOptionsFor('codex', codex).map((option) => option.value)).toEqual([
      null,
      'low',
      'medium',
      'high',
    ]);
    // Claude: `supportedEffortLevels: ["low", …]` on the Default row.
    const claude = readSessionModels([
      { value: 'default', displayName: 'Default', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    ]);
    expect(effortOptionsFor('claude', claude).map((option) => option.value)).toEqual([
      null,
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  it('falls back to the static ladder when no row says anything', () => {
    expect(effortOptionsFor('claude', readSessionModels(REAL_CATALOG))).toEqual(EFFORT_OPTIONS);
  });

  it('clamps an effort the current ladder lacks to Auto', () => {
    expect(clampEffort('xhigh', effortOptionsFor('claude'))).toBeNull();
    expect(clampEffort('max', effortOptionsFor('codex'))).toBeNull();
    expect(clampEffort('high', effortOptionsFor('codex'))).toBe('high');
    expect(clampEffort('max', effortOptionsFor('claude'))).toBe('max');
    expect(clampEffort(null, effortOptionsFor('codex'))).toBeNull();
  });
});
