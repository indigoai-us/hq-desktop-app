// @vitest-environment happy-dom
/**
 * The `/` discovery picker, mounted for real — through the composer, because
 * the composer's draft is the picker's search and its textarea is the
 * keyboard. Grouping, filtering, the worker → skill drill-down and the exact
 * text a pick inserts are DOM facts here, not source strings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionComposer from './SessionComposer.svelte';
import SlashPicker from './SlashPicker.svelte';
import type { SkillCatalog } from './slash-commands';

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

  it('the Skills tab groups by scope with a tag row that narrows', () => {
    renderComposer();
    type('/');
    click(must('session-slash-tab-skills'));
    const labels = [...host.querySelectorAll('.section-label')].map((node) => node.textContent?.trim());
    expect(labels).toEqual(['indigo', 'Personal', 'Core', 'Packages']);
    const tags = all('session-slash-tag').map((tag) => tag.textContent?.trim());
    expect(tags).toEqual(['google', 'knowledge', 'people', 'session']);
    click(all('session-slash-tag')[3]!);
    expect(names()).toEqual(['/handoff']);
  });
});

describe('workers drill down', () => {
  it('picking a worker lists its skills; picking a skill inserts /run {worker} {skill}', () => {
    renderComposer();
    type('/');
    click(must('session-slash-tab-workers'));
    expect(names()).toEqual(['Designer']);
    click(all('session-slash-item')[0]!);
    expect(names()).toEqual(['← Workers', '/run designer mockup', '/run designer critique']);
    click(all('session-slash-item')[2]!);
    expect((must('session-composer-input') as HTMLTextAreaElement).value).toBe('/run designer critique ');
    expect(at('session-slash-menu')).toBeNull();
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

  it('a pick lands in Recent, most recent first', () => {
    renderComposer();
    let input = type('/mo');
    key(input, 'Enter');
    input = type('/cap');
    key(input, 'Enter');
    type('/');
    const recent = all('session-slash-section').find((section) => section.getAttribute('data-group') === 'recent');
    expect(recent).toBeDefined();
    const recentNames = [...recent!.querySelectorAll('.name')].map((node) => node.textContent?.trim());
    expect(recentNames).toEqual(['/indigo:capture', '/model']);
    expect(globalThis.localStorage.getItem('hq.sessions.recentSlash')).toContain('/indigo:capture ');
  });
});

describe('the picker alone caps each group at 60 rows with a "more…" affordance', () => {
  it('renders 60 then expands', () => {
    const big: SkillCatalog = {
      workers: [],
      skills: Array.from({ length: 75 }, (_, i) => ({
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
    expect(all('session-slash-item')).toHaveLength(60);
    expect(must('session-slash-more').textContent).toContain('15 more');
    click(must('session-slash-more'));
    expect(all('session-slash-item')).toHaveLength(75);
    expect(at('session-slash-more')).toBeNull();
  });
});
