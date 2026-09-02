// @vitest-environment happy-dom
/**
 * The `/` discovery picker, mounted for real — through the composer, because
 * the composer's draft is the picker's search and its textarea is the
 * keyboard. Grouping, the scope/tag filter row, the kind pills, the worker →
 * skill drill-down, and the chip a pick leaves above the draft are DOM facts
 * here, not source strings — and so is the exact text a send carries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionComposer from './SessionComposer.svelte';
import SlashPicker from './SlashPicker.svelte';
import { PICKER_PAGE, type SkillCatalog } from './slash-commands';

const CATALOG: SkillCatalog = {
  workers: [
    {
      id: 'designer',
      name: 'Designer',
      description: 'Design work',
      company: null,
      skills: [
        { name: 'mockup', description: 'Draw a mockup', tags: ['design'], invoke: '/run designer mockup' },
        { name: 'critique', description: 'Critique a screen', tags: ['review'], invoke: '/run designer critique' },
      ],
    },
  ],
  skills: [
    { name: 'handoff', description: 'End the session', scope: 'core', tags: ['session'], invoke: '/handoff' },
    { name: 'capture', description: 'Capture knowledge', scope: 'company:indigo', tags: ['knowledge'], invoke: '/indigo:capture' },
    { name: 'dm', description: 'Send a DM', scope: 'personal', tags: ['people'], invoke: '/personal:dm' },
    { name: 'gws-gmail', description: 'Gmail', scope: 'package', tags: ['google'], invoke: '/gws-gmail' },
  ],
};

const CLI = [
  { name: 'compact', description: 'Compact the context' },
  { name: 'model', description: 'Switch model', argumentHint: '[name]' },
  { name: 'handoff', description: 'CLI copy of handoff' },
];

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

const at = (testid: string): HTMLElement | null => host.querySelector(`[data-testid="${testid}"]`);
const all = (testid: string): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(`[data-testid="${testid}"]`)];
const must = (testid: string): HTMLElement => {
  const found = at(testid);
  if (!found) throw new Error(`missing [data-testid="${testid}"]`);
  return found;
};
const click = (element: HTMLElement) => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  flushSync();
};
const names = () => all('session-slash-item').map((row) => row.querySelector('.name')?.textContent?.trim());
const kinds = () => all('session-slash-item').map((row) => row.getAttribute('data-kind'));
const text = (testid: string) => all(testid).map((node) => node.textContent?.trim());

function renderComposer(props: Record<string, unknown> = {}) {
  component = mount(SessionComposer, {
    target: host,
    props: {
      companies: [{ slug: 'indigo', displayName: 'Indigo' }],
      company: 'indigo',
      catalog: CATALOG,
      commands: CLI,
      ...props,
    },
  }) as Record<string, unknown>;
  flushSync();
}

function type(text: string): HTMLTextAreaElement {
  const input = must('session-composer-input') as HTMLTextAreaElement;
  input.value = text;
  input.setSelectionRange?.(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return input;
}

const key = (input: HTMLElement, k: string, init: KeyboardEventInit = {}) => {
  input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  flushSync();
};

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

describe('opening', () => {
  it('opens on a bare / with every group sectioned, and closes once arguments start', () => {
    renderComposer();
    expect(at('session-slash-menu')).toBeNull();
    type('/');
    expect(at('session-slash-menu')).not.toBeNull();
    const groups = all('session-slash-section').map((section) => section.getAttribute('data-group'));
    // No Recent yet, so: workers, skills, cli.
    expect(groups).toEqual(['workers', 'skills', 'cli']);
    type('/handoff now');
    expect(at('session-slash-menu')).toBeNull();
  });

  it('has a segmented header — All · Recent · Workers · Skills · Commands — with All on by default', () => {
    renderComposer();
    type('/');
    const tabs = [...must('session-slash-tabs').querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['All', 'Recent', 'Workers', 'Skills', 'Commands']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    // The overview labels its sections.
    expect([...host.querySelectorAll('.section-label')].map((node) => node.textContent?.trim())).toEqual([
      'Workers',
      'Skills',
      'Commands',
    ]);
  });

  it('shows skills company-first and CLI commands minus what HQ already names', () => {
    renderComposer();
    type('/');
    expect(names()).toEqual([
      'Designer',
      '/indigo:capture',
      '/personal:dm',
      '/handoff',
      '/gws-gmail',
      '/compact',
      '/model',
    ]);
    // The CLI's own /handoff is dropped — HQ's row carries the description.
    expect(names().filter((name) => name === '/handoff')).toHaveLength(1);
  });

  it('every row wears a kind pill, and the scope rides as a muted tag', () => {
    renderComposer();
    type('/');
    expect(kinds()).toEqual(['worker', 'skill', 'skill', 'skill', 'skill', 'cli', 'cli']);
    expect(text('session-slash-kind')).toEqual([
      'worker',
      'skill',
      'skill',
      'skill',
      'skill',
      'command',
      'command',
    ]);
    const scopes = all('session-slash-item').map((row) => row.querySelector('.scope')?.textContent?.trim() ?? null);
    expect(scopes).toEqual([null, 'indigo', 'Personal', 'Core', 'Packages', null, null]);
  });

  it('the search box holds the query and takes the caret', async () => {
    renderComposer();
    type('/ha');
    const search = must('session-slash-search') as HTMLInputElement;
    expect(search.value).toBe('ha');
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(search);
  });

  it('shows a loading note before the catalog lands and the error line when it fails', () => {
    renderComposer({ catalog: null, catalogLoading: true });
    type('/');
    expect(at('session-slash-loading')).not.toBeNull();
    if (component) unmount(component);
    component = null;
    renderComposer({ catalog: null, catalogError: 'registry unreadable' });
    type('/');
    expect(must('session-slash-error').textContent).toContain('registry unreadable');
    // The CLI rows still show.
    expect(names()).toEqual(['/compact', '/model', '/handoff']);
    // No skills → no filter row to offer.
    expect(at('session-slash-tags')).toBeNull();
  });
});

describe('filtering', () => {
  it('the draft is the search: it filters across names, descriptions and tags', () => {
    renderComposer();
    type('/cap');
    expect(names()).toEqual(['/indigo:capture']);
    type('/knowledge');
    expect(names()).toEqual(['/indigo:capture']);
    type('/design');
    expect(names()).toEqual(['Designer']);
    type('/zzz');
    expect(at('session-slash-empty')).not.toBeNull();
  });

  it('the search box mirrors the draft both ways', () => {
    renderComposer();
    type('/ha');
    const search = must('session-slash-search') as HTMLInputElement;
    expect(search.value).toBe('ha');
    search.value = 'mod';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect((must('session-composer-input') as HTMLTextAreaElement).value).toBe('/mod');
    expect(names()).toEqual(['/model']);
  });

  it('the scope/tag filter row is visible on the overview, and a chip lands on Skills', () => {
    renderComposer();
    type('/');
    expect(at('session-slash-tags')).not.toBeNull();
    expect(text('session-slash-scope')).toEqual(['indigo', 'Personal', 'Core', 'Packages']);
    expect(text('session-slash-tag')).toEqual(['google', 'knowledge', 'people', 'session']);
    click(all('session-slash-scope')[2]!); // Core
    expect(must('session-slash-tab-skills').getAttribute('aria-selected')).toBe('true');
    expect(names()).toEqual(['/handoff']);
    expect(all('session-slash-scope')[2]?.getAttribute('aria-pressed')).toBe('true');
    // The tag row follows the scope.
    expect(text('session-slash-tag')).toEqual(['session']);
    // A second press clears the scope.
    click(all('session-slash-scope')[2]!);
    expect(names()).toEqual(['/indigo:capture', '/personal:dm', '/handoff', '/gws-gmail']);
  });

  it('the Skills tab groups by scope with a tag row that narrows', () => {
    renderComposer();
    type('/');
    click(must('session-slash-tab-skills'));
    const labels = [...host.querySelectorAll('.section-label')].map((node) => node.textContent?.trim());
    expect(labels).toEqual(['indigo', 'Personal', 'Core', 'Packages']);
    expect(text('session-slash-tag')).toEqual(['google', 'knowledge', 'people', 'session']);
    click(all('session-slash-tag')[3]!);
    expect(names()).toEqual(['/handoff']);
    // Company chip on top of the tag: nothing in indigo is tagged `session`.
    click(all('session-slash-scope')[0]!);
    expect(names()).toEqual([]);
    expect(at('session-slash-empty')).not.toBeNull();
  });
});

describe('workers drill down', () => {
  it('picking a worker lists its skills under a back link; picking a skill inserts /run {worker} {skill}', () => {
    renderComposer();
    type('/');
    click(must('session-slash-tab-workers'));
    expect(names()).toEqual(['Designer']);
    click(all('session-slash-item')[0]!);
    expect(must('session-slash-drill').textContent).toContain('Designer');
    expect(must('session-slash-drill').textContent).toContain('Design work');
    expect(names()).toEqual(['/run designer mockup', '/run designer critique']);
    expect(kinds()).toEqual(['worker-skill', 'worker-skill']);
    // The filter row is not a skills filter here.
    expect(at('session-slash-tags')).toBeNull();
    // Back returns to the worker list.
    click(must('session-slash-back'));
    expect(at('session-slash-drill')).toBeNull();
    expect(names()).toEqual(['Designer']);
    click(all('session-slash-item')[0]!);
    click(all('session-slash-item')[1]!);
    expect((must('session-composer-input') as HTMLTextAreaElement).value).toBe('/run designer critique ');
    expect(at('session-slash-menu')).toBeNull();
  });

  it('Escape inside a worker goes back, not out', () => {
    renderComposer();
    const input = type('/');
    key(input, 'Enter'); // Designer is first → drill in
    expect(at('session-slash-drill')).not.toBeNull();
    key(input, 'Escape');
    expect(at('session-slash-drill')).toBeNull();
    expect(at('session-slash-menu')).not.toBeNull();
    key(input, 'Escape');
    expect(at('session-slash-menu')).toBeNull();
  });
});

describe('the command chip a pick leaves above the draft', () => {
  it('a worker skill becomes a `worker · skill` chip and the send carries the exact command', () => {
    const onsend = vi.fn();
    renderComposer({ onsend });
    type('/');
    click(all('session-slash-item')[0]!); // Designer
    click(all('session-slash-item')[0]!); // mockup
    const chip = must('session-command-chip');
    expect(chip.getAttribute('data-kind')).toBe('worker-skill');
    expect(chip.querySelector('.command-chip-kind')?.textContent?.trim()).toBe('worker skill');
    expect(chip.querySelector('.command-chip-name')?.textContent?.trim()).toBe('designer · mockup');
    const input = type('/run designer mockup the login screen');
    // Still the same token at the front: the chip stays.
    expect(at('session-command-chip')).not.toBeNull();
    key(input, 'Enter');
    expect(onsend).toHaveBeenCalledTimes(1);
    expect(onsend.mock.calls[0]?.[0]).toBe('/run designer mockup the login screen');
    // Sent → chip gone with the draft.
    expect(at('session-command-chip')).toBeNull();
    expect(input.value).toBe('');
  });

  it('a skill and a CLI command get their own kinds, and editing the token away drops the chip', () => {
    renderComposer();
    let input = type('/hand');
    key(input, 'Enter');
    expect(must('session-command-chip').getAttribute('data-kind')).toBe('skill');
    expect(must('session-command-chip').querySelector('.command-chip-name')?.textContent?.trim()).toBe('/handoff');
    type('/hando');
    expect(at('session-command-chip')).toBeNull();
    // It does not come back once the text matches again by accident.
    type('/handoff ');
    expect(at('session-command-chip')).toBeNull();

    input = type('/mo');
    key(input, 'Tab');
    expect(input.value).toBe('/model ');
    expect(must('session-command-chip').getAttribute('data-kind')).toBe('cli');
    expect(must('session-command-chip').querySelector('.command-chip-kind')?.textContent?.trim()).toBe('command');
  });

  it('the chip\'s × removes the command from the draft and keeps what followed', () => {
    renderComposer();
    const input = type('/hand');
    key(input, 'Enter');
    type('/handoff and then stop');
    click(must('session-command-remove'));
    expect(at('session-command-chip')).toBeNull();
    expect(input.value).toBe('and then stop');
  });
});

describe('keyboard', () => {
  it('Down / Up move the highlight, Enter inserts, Escape closes, and the send never fires', () => {
    const onsend = vi.fn();
    renderComposer({ onsend });
    const input = type('/');
    expect(all('session-slash-item')[0]?.getAttribute('aria-selected')).toBe('true');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    expect(all('session-slash-item')[2]?.getAttribute('aria-selected')).toBe('true');
    // The highlighted row is the only one wearing the ↵ hint.
    expect(all('session-slash-item').filter((row) => row.querySelector('.enter'))).toHaveLength(1);
    key(input, 'ArrowUp');
    expect(all('session-slash-item')[1]?.getAttribute('aria-selected')).toBe('true');
    key(input, 'Enter');
    expect(onsend).not.toHaveBeenCalled();
    expect(input.value).toBe('/indigo:capture ');
    expect(at('session-slash-menu')).toBeNull();

    type('/');
    expect(at('session-slash-menu')).not.toBeNull();
    key(input, 'Escape');
    expect(at('session-slash-menu')).toBeNull();
    expect(input.value).toBe('/');
    // Tab picks too.
    type('/mo');
    key(input, 'Tab');
    expect(input.value).toBe('/model ');
  });

  it('a pick lands in Recent, most recent first, with its kind', () => {
    renderComposer();
    let input = type('/mo');
    key(input, 'Enter');
    input = type('/cap');
    key(input, 'Enter');
    type('/');
    const recent = all('session-slash-section').find((section) => section.getAttribute('data-group') === 'recent');
    expect(recent).toBeDefined();
    const rows = [...recent!.querySelectorAll<HTMLElement>('[data-testid="session-slash-item"]')];
    expect(rows.map((row) => row.querySelector('.name')?.textContent?.trim())).toEqual(['/indigo:capture', '/model']);
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['skill', 'cli']);
    expect(globalThis.localStorage.getItem('hq.sessions.recentSlash')).toContain('"kind":"cli"');
  });
});

describe(`the picker alone caps each group at ${PICKER_PAGE} rows with a "more…" affordance`, () => {
  it('renders eight then expands', () => {
    const big: SkillCatalog = {
      workers: [],
      skills: Array.from({ length: 20 }, (_, i) => ({
        name: `s${i}`,
        description: '',
        scope: 'core',
        tags: [],
        invoke: `/s${String(i).padStart(2, '0')}`,
      })),
    };
    component = mount(SlashPicker, {
      target: host,
      props: { query: '', catalog: big, cliCommands: [], company: null, recent: [] },
    }) as Record<string, unknown>;
    flushSync();
    expect(PICKER_PAGE).toBe(8);
    expect(all('session-slash-item')).toHaveLength(8);
    expect(must('session-slash-more').textContent).toContain('12 more');
    click(must('session-slash-more'));
    expect(all('session-slash-item')).toHaveLength(20);
    expect(at('session-slash-more')).toBeNull();
  });
});
