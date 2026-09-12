// @vitest-environment happy-dom
//
// hq-idea-board US-012 acceptance specs for the Ideas settings section.
//
// Two of the story's three declared e2e scenarios, driven against the real
// component across a mocked Tauri boundary — the same shape as the US-009 and
// US-010 specs in this directory (rendered component + a source contract over
// the Rust command layer):
//
//   (a) the model-extraction disclosure is on screen BEFORE any interaction,
//       and the model preference round-trips through the host.
//   (b) rebinding to a chord another app already holds shows an inline failure
//       and leaves the previous chord active.
//
// The story's third scenario (Sync off keeping captures off the vault) is NOT
// asserted here, deliberately: the preference is stored and read back, but the
// capture write path still resolves every capture through the company vault,
// so there is no end-to-end behaviour to assert yet. What IS asserted is that
// the panel says so rather than promising otherwise.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, updateSettingsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (..._args: unknown[]): Promise<unknown> => undefined),
  updateSettingsMock: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async () => () => {},
  emit: async () => {},
  once: async () => () => {},
  TauriEvent: {},
}));
vi.mock('../../src/lib/settings-mutations', () => ({
  updateSettings: (...args: unknown[]) => updateSettingsMock(...args),
}));

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import IdeasSettings from '../../src/components/IdeasSettings.svelte';

const APP_ROOT = resolve(__dirname, '../..');

/**
 * The disclosure literal the host owns. Read from the Rust constant rather
 * than retyped, so this spec moves with the source instead of pinning a copy
 * of it: if `MODEL_DISCLOSURE` is reworded, the assertion follows.
 */
const MODEL_RS = readFileSync(
  resolve(APP_ROOT, '../../crates/hq-desktop-core/src/ideas/extract/model.rs'),
  'utf8',
);
const MODEL_DISCLOSURE = (() => {
  const match = MODEL_RS.match(
    // `[\s\S]` rather than `.`: the literal uses Rust's backslash-newline
    // line continuation, which `.` will not cross.
    /pub const MODEL_DISCLOSURE: &str =\s*"((?:[^"\\]|\\[\s\S])*)"/,
  );
  if (!match) throw new Error('MODEL_DISCLOSURE literal not found in model.rs');
  return match[1]
    // Rust's line-continuation escape: backslash-newline swallows the newline
    // and the leading whitespace on the next line.
    .replace(/\\\n\s*/g, '')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n');
})();

const BASE_STATE = {
  extractionMode: 'local',
  syncEnabled: true,
  defaultCompany: null,
  activeCompany: 'indigo',
  imageMaxEdge: 2000,
  imageMaxEdgeChoices: [1200, 2000, 4000],
  captureChord: 'Alt+Shift+KeyC',
  captureChordDisplay: '⌥⇧C',
  modelDisclosure: MODEL_DISCLOSURE,
  localOnly: false,
  capturesRoot: '/tmp/HQ/companies/indigo/ideas',
};

/** The host's own refusal wording, read from the Rust constant. */
const IDEAS_SETTINGS_RS = readFileSync(
  resolve(APP_ROOT, 'src-tauri/src/commands/ideas_settings.rs'),
  'utf8',
);
const CHORD_TAKEN = (() => {
  const match = IDEAS_SETTINGS_RS.match(/const CHORD_TAKEN: &str =\s*"((?:[^"\\]|\\.)*)"/);
  if (!match) throw new Error('CHORD_TAKEN literal not found in ideas_settings.rs');
  return match[1].replace(/\\"/g, '"');
})();

let mounted: ReturnType<typeof mount> | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
    flushSync();
  }
}

function routeInvoke(overrides: Record<string, unknown> = {}): void {
  invokeMock.mockImplementation(async (command: unknown) => {
    if (command === 'ideas_get_settings') return { ...BASE_STATE, ...overrides };
    if (command === 'ideas_list_companies') return ['indigo', 'liverecover'];
    return undefined;
  });
}

async function mountPanel(): Promise<HTMLElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  mounted = mount(IdeasSettings, { target });
  flushSync();
  await settle();
  return target;
}

function testid(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  invokeMock.mockReset();
  updateSettingsMock.mockReset();
  updateSettingsMock.mockResolvedValue(undefined);
  routeInvoke();
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

describe('US-012 (a) — the model disclosure is readable before any choice', () => {
  it('renders the host disclosure on first paint, with no interaction at all', async () => {
    const root = await mountPanel();

    const disclosure = testid(root, 'ideas-model-disclosure');
    expect(disclosure).not.toBeNull();
    // The exact host copy, not a front-end paraphrase.
    expect(disclosure?.textContent?.replace(/\s+/g, ' ').trim()).toContain(
      MODEL_DISCLOSURE.replace(/\s+/g, ' ').trim(),
    );
    // It states both facts a user needs before opting in.
    expect(MODEL_DISCLOSURE).toMatch(/leaves this device/i);
    expect(MODEL_DISCLOSURE).toMatch(/cost/i);

    // Disclosure ABOVE the control: a disclosure you only see after flipping
    // the switch is not a disclosure.
    const control = testid(root, 'ideas-extraction-model');
    expect(control).not.toBeNull();
    expect(
      disclosure!.compareDocumentPosition(control!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Nothing was opted into by rendering.
    expect(testid(root, 'ideas-extraction-chip')?.textContent?.trim()).toBe('On device');
    expect(updateSettingsMock).not.toHaveBeenCalled();
  });

  it('round-trips the model preference: explicit click writes it, reload shows it', async () => {
    const root = await mountPanel();
    (testid(root, 'ideas-extraction-model') as HTMLButtonElement).click();
    await settle();

    expect(updateSettingsMock).toHaveBeenCalledWith({ ideasExtractionMode: 'model' });
    expect(testid(root, 'ideas-extraction-chip')?.textContent?.trim()).toBe('Model');

    // A fresh mount over a host that has the stored value shows it back.
    unmount(mounted!);
    mounted = null;
    document.body.innerHTML = '';
    routeInvoke({ extractionMode: 'model' });
    const reloaded = await mountPanel();
    expect(testid(reloaded, 'ideas-extraction-chip')?.textContent?.trim()).toBe('Model');
    expect(
      (testid(reloaded, 'ideas-extraction-model') as HTMLButtonElement).getAttribute('aria-checked'),
    ).toBe('true');
  });
});

describe('US-012 (b) — rebinding to a chord another app holds', () => {
  function pressChord(button: HTMLElement, init: KeyboardEventInit): void {
    button.click();
    flushSync();
    button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  }

  it('shows the failure inline and leaves the previous chord active', async () => {
    const root = await mountPanel();
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');

    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_get_settings') return { ...BASE_STATE };
      if (command === 'ideas_list_companies') return ['indigo'];
      if (command === 'ideas_set_capture_chord') throw CHORD_TAKEN;
      return undefined;
    });

    pressChord(testid(root, 'ideas-chord-rebind')!, {
      code: 'KeyS',
      key: 's',
      ctrlKey: true,
      altKey: true,
    });
    await settle();

    // Inline, in the row — never a native dialog.
    const error = testid(root, 'ideas-chord-error');
    expect(error).not.toBeNull();
    expect(error?.getAttribute('role')).toBe('alert');
    expect(error?.textContent).toContain('already in use by another app');
    expect(error?.textContent).toContain('previous chord is still active');

    // The previous chord is still what the panel shows, and nothing was saved.
    expect(testid(root, 'ideas-chord-chip')?.textContent?.trim()).toBe('⌥⇧C');
    expect(updateSettingsMock).not.toHaveBeenCalled();

    // The host was asked once, for the chord the user actually pressed.
    expect(invokeMock).toHaveBeenCalledWith('ideas_set_capture_chord', {
      chord: 'Ctrl+Alt+KeyS',
    });
  });

  it('uses no native dialog for the refusal', async () => {
    const confirmSpy = vi.fn(() => true);
    const alertSpy = vi.fn();
    Object.assign(window, { confirm: confirmSpy, alert: alertSpy });

    const root = await mountPanel();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === 'ideas_get_settings') return { ...BASE_STATE };
      if (command === 'ideas_list_companies') return ['indigo'];
      if (command === 'ideas_set_capture_chord') throw CHORD_TAKEN;
      return undefined;
    });
    pressChord(testid(root, 'ideas-chord-rebind')!, {
      code: 'KeyS',
      key: 's',
      ctrlKey: true,
      altKey: true,
    });
    await settle();

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe('US-012 — the sync row states its deferral instead of promising privacy', () => {
  it('does not claim captures already stay local', async () => {
    // Not an assertion about deferred behaviour — an assertion that the panel
    // does not assert deferred behaviour. `ideasSyncEnabled` has no consumer
    // on the write path, so present-tense copy here would be false.
    routeInvoke({
      syncEnabled: false,
      localOnly: true,
      capturesRoot: '/tmp/HQ/workspace/ideas-local/indigo',
    });
    const root = await mountPanel();

    const note = testid(root, 'ideas-local-only-note');
    expect(note).not.toBeNull();
    expect(testid(root, 'ideas-local-only-pending')?.textContent).toContain('Not in effect yet');
    expect(note?.textContent).toContain('still go to your company vault');
    expect(note?.textContent).not.toContain('Captures stay on this machine');
  });
});

describe('US-012 — the Rust command surface the panel depends on', () => {
  const mainRs = readFileSync(resolve(APP_ROOT, 'src-tauri/src/main.rs'), 'utf8');

  it('defines ideas_get_settings and ideas_set_capture_chord as tauri commands', () => {
    expect(IDEAS_SETTINGS_RS).toMatch(
      /#\[tauri::command\][\s\S]{0,400}?fn ideas_get_settings\b/,
    );
    expect(IDEAS_SETTINGS_RS).toMatch(
      /#\[tauri::command\][\s\S]{0,400}?fn ideas_set_capture_chord\b/,
    );
  });

  it('registers both in the invoke handler', () => {
    expect(mainRs).toContain('commands::ideas_settings::ideas_get_settings');
    expect(mainRs).toContain('commands::ideas_settings::ideas_set_capture_chord');
  });

  it('serializes the resolved root as capturesRoot, not local_only_root', () => {
    // The field carries the SYNCED vault path when sync is on, so the old name
    // was wrong on the wire as well as in the panel.
    expect(IDEAS_SETTINGS_RS).toContain('pub captures_root: String');
    // No field by the old name survives (the name is still mentioned in a doc
    // comment explaining the rename, which is why this is anchored to `pub`).
    expect(IDEAS_SETTINGS_RS).not.toContain('pub local_only_root');
    expect(IDEAS_SETTINGS_RS).not.toMatch(/^\s*local_only_root:/m);
  });
});
