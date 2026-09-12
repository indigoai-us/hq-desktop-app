// hq-idea-board US-012: the Ideas settings adapter — the boundary that
// normalizes whatever the host hands back, maps preference writes onto the
// stored menubar.json keys, and describes the board-header "local only" badge.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, updateSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  updateSettingsMock: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('../settings-mutations', () => ({
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
}));

import {
  listIdeaCompanies,
  loadIdeasSettings,
  localOnlyBadge,
  normalizeCompanies,
  saveIdeasPrefs,
  setCaptureChord,
  type IdeasSettingsState,
} from './ideas-settings';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  updateSettingsMock.mockReset();
  updateSettingsMock.mockResolvedValue(undefined);
});

function state(overrides: Partial<IdeasSettingsState> = {}): IdeasSettingsState {
  return {
    extractionMode: 'local',
    syncEnabled: true,
    defaultCompany: null,
    activeCompany: 'indigo',
    imageMaxEdge: 2000,
    imageMaxEdgeChoices: [1200, 2000, 4000],
    captureChord: 'Alt+Shift+KeyC',
    captureChordDisplay: '⌥⇧C',
    modelDisclosure: 'disclosure',
    localOnly: false,
    capturesRoot: '/tmp/HQ/companies/indigo/ideas',
    ...overrides,
  };
}

describe('company list normalization', () => {
  it('accepts a bare array of slugs (what ideas_list_companies returns today)', () => {
    expect(normalizeCompanies(['indigo', 'liverecover'])).toEqual([
      { slug: 'indigo', name: 'indigo' },
      { slug: 'liverecover', name: 'liverecover' },
    ]);
  });

  it('accepts an array of objects and keeps a display name when present', () => {
    expect(
      normalizeCompanies([
        { slug: 'indigo', name: 'Indigo' },
        { slug: 'liverecover' },
      ]),
    ).toEqual([
      { slug: 'indigo', name: 'Indigo' },
      { slug: 'liverecover', name: 'liverecover' },
    ]);
  });

  it('unwraps an object-wrapped array under companies or items', () => {
    expect(normalizeCompanies({ companies: ['indigo'] })).toEqual([
      { slug: 'indigo', name: 'indigo' },
    ]);
    expect(normalizeCompanies({ items: [{ slug: 'indigo', name: 'Indigo' }] })).toEqual([
      { slug: 'indigo', name: 'Indigo' },
    ]);
  });

  it('degrades to an empty list rather than throwing on null, undefined, or junk', () => {
    expect(normalizeCompanies(null)).toEqual([]);
    expect(normalizeCompanies(undefined)).toEqual([]);
    expect(normalizeCompanies('indigo')).toEqual([]);
    expect(normalizeCompanies(42)).toEqual([]);
    expect(normalizeCompanies({ other: ['indigo'] })).toEqual([]);
  });

  it('drops entries that carry no usable slug', () => {
    expect(normalizeCompanies(['', '  ', {}, { slug: '   ' }, null, 7, 'indigo'])).toEqual([
      { slug: 'indigo', name: 'indigo' },
    ]);
  });

  it('normalizes through the live command call too', async () => {
    invokeMock.mockResolvedValueOnce({ companies: ['indigo'] });
    await expect(listIdeaCompanies()).resolves.toEqual([{ slug: 'indigo', name: 'indigo' }]);
    expect(invokeMock).toHaveBeenCalledWith('ideas_list_companies');
  });
});

describe('command calls', () => {
  it('loads settings through ideas_get_settings', async () => {
    invokeMock.mockResolvedValueOnce(state());
    await expect(loadIdeasSettings()).resolves.toEqual(state());
    expect(invokeMock).toHaveBeenCalledWith('ideas_get_settings');
  });

  it('rebinds the chord through ideas_set_capture_chord with a named argument', async () => {
    invokeMock.mockResolvedValueOnce({ chord: 'Ctrl+Alt+KeyS', display: '⌃⌥S' });
    await expect(setCaptureChord('Ctrl+Alt+KeyS')).resolves.toEqual({
      chord: 'Ctrl+Alt+KeyS',
      display: '⌃⌥S',
    });
    expect(invokeMock).toHaveBeenCalledWith('ideas_set_capture_chord', {
      chord: 'Ctrl+Alt+KeyS',
    });
  });

  it('propagates a rebind rejection instead of swallowing it', async () => {
    invokeMock.mockRejectedValueOnce('That chord is already in use by another app.');
    await expect(setCaptureChord('Ctrl+Alt+KeyS')).rejects.toBe(
      'That chord is already in use by another app.',
    );
  });
});

describe('preference writes', () => {
  it('goes through the shared settings queue, never raw save_settings', async () => {
    await saveIdeasPrefs({ ideasExtractionMode: 'model' });
    expect(updateSettingsMock).toHaveBeenCalledWith({ ideasExtractionMode: 'model' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('maps each preference onto its stored menubar.json key', async () => {
    await saveIdeasPrefs({ ideasSyncEnabled: false });
    await saveIdeasPrefs({ ideasDefaultCompany: 'liverecover' });
    await saveIdeasPrefs({ ideasDefaultCompany: null });
    await saveIdeasPrefs({ ideasImageMaxEdge: 4000 });
    expect(updateSettingsMock.mock.calls.map((c) => c[0])).toEqual([
      { ideasSyncEnabled: false },
      { ideasDefaultCompany: 'liverecover' },
      { ideasDefaultCompany: null },
      { ideasImageMaxEdge: 4000 },
    ]);
  });
});

describe('local-only badge (the board-header seam)', () => {
  it('is absent while captures sync', () => {
    expect(localOnlyBadge(state({ syncEnabled: true }))).toBeNull();
  });

  it('names the badge and the root new captures are written to when sync is off', () => {
    const badge = localOnlyBadge(
      state({ syncEnabled: false, capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' }),
    );
    expect(badge?.label).toBe('local only');
    expect(badge?.title).toContain('/tmp/HQ/workspace/ideas-local/indigo');
    expect(badge?.title).toContain('not synced to your team');
  });

  it('claims privacy only for NEW captures, never retroactively', () => {
    // REGRESSION GUARD, the mirror of the one this replaced. The capture write
    // path now resolves its root from `ideasSyncEnabled`, so present tense is
    // earned for captures taken from here on. What is still FALSE — and what
    // this test forbids — is any unqualified claim that the user's captures are
    // off the vault: the ones taken while sync was on are still there and still
    // sync, because nothing moves them.
    const badge = localOnlyBadge(
      state({ syncEnabled: false, capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' }),
    );
    const text = `${badge?.label} ${badge?.title}`;
    expect(text).toContain('New captures');
    expect(text).toContain('still in the vault and still sync');
    for (const overclaim of [
      'Your captures stay on this machine',
      'Captures are not synced to your team.',
      'Nothing is in the vault',
      'no longer sync',
    ]) {
      expect(text, `the badge must not claim: ${overclaim}`).not.toContain(overclaim);
    }
  });

  it('fails CLOSED on a malformed payload rather than claiming privacy', () => {
    // REGRESSION GUARD (review critical). `!state.syncEnabled` would render the
    // badge for any payload where the field is merely absent — an array, an
    // error envelope, an older host — and the badge asserts "not synced to your
    // team". Over captures that ARE syncing, that is a false privacy promise.
    // Unknown posture must show nothing.
    for (const malformed of [
      [],
      {},
      { capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' },
      { syncEnabled: undefined },
      { syncEnabled: null },
      { syncEnabled: 0 },
      { syncEnabled: '' },
    ]) {
      expect(
        localOnlyBadge(malformed as never),
        `a payload without an explicit syncEnabled:false must not claim local-only: ${JSON.stringify(malformed)}`,
      ).toBeNull();
    }
    // ...and a truthy non-boolean must not suppress a real badge by accident:
    // only an explicit false turns it on.
    expect(localOnlyBadge({ syncEnabled: false, capturesRoot: '' })).not.toBeNull();
  });

  it('still renders a badge when the root is unknown, and tolerates no state', () => {
    const badge = localOnlyBadge(state({ syncEnabled: false, capturesRoot: '' }));
    expect(badge?.label).toBe('local only');
    expect(badge?.title).toContain('a folder on this machine');
    expect(badge?.title).not.toContain('undefined');
    expect(localOnlyBadge(null)).toBeNull();
    expect(localOnlyBadge(undefined)).toBeNull();
  });
});
