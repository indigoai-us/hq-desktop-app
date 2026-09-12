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

  it('describes the badge and where captures will go when sync is off', () => {
    const badge = localOnlyBadge(
      state({ syncEnabled: false, capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' }),
    );
    expect(badge?.label).toBe('local only — not in effect yet');
    expect(badge?.title).toContain('/tmp/HQ/workspace/ideas-local/indigo');
  });

  it('never claims captures already stay off the vault', () => {
    // REGRESSION GUARD. The sync preference is stored and read back, but the
    // capture write path still resolves every capture through the company
    // vault, so a present-tense badge here would be a false privacy promise.
    // If someone re-enables the present tense before the write path lands,
    // this fails.
    const badge = localOnlyBadge(
      state({ syncEnabled: false, capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo' }),
    );
    const text = `${badge?.label} ${badge?.title}`;
    expect(text).toContain('not in effect yet');
    expect(text).toContain('still go to the vault');
    for (const lie of [
      'Captures are not syncing',
      'They stay in',
      'stay on this machine',
      'do not sync',
    ]) {
      expect(text).not.toContain(lie);
    }
  });

  it('still renders a badge when the root is unknown, and tolerates no state', () => {
    const badge = localOnlyBadge(state({ syncEnabled: false, capturesRoot: '' }));
    expect(badge?.label).toBe('local only — not in effect yet');
    expect(badge?.title).toContain('still go to the vault');
    expect(badge?.title).not.toContain('undefined');
    // No root to name, so the title must not trail an empty sentence.
    expect(badge?.title).not.toContain('will go to');
    expect(localOnlyBadge(null)).toBeNull();
    expect(localOnlyBadge(undefined)).toBeNull();
  });
});
