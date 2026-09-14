// @vitest-environment happy-dom
/**
 * The project picker, mounted for real. Search, the recency order, the person
 * and status chips, "No project" first, the row anatomy (initials, "updated",
 * the story bar) and the keyboard are asserted on the DOM — the pure
 * decisions behind them are covered in `startwork.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import ProjectPicker from './ProjectPicker.svelte';
import type { ProjectEntry } from './startwork';

const row = (name: string, over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  name,
  description: '',
  branchName: null,
  path: `/hq/companies/indigo/projects/${name}`,
  storyCounts: { total: 0, done: 0 },
  updatedAt: null,
  owner: null,
  lastActivityAt: null,
  status: 'active',
  ...over,
});

const HOUR = 60 * 60 * 1000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();

const PROJECTS: ProjectEntry[] = [
  row('ads', {
    description: 'Meta ads reporting',
    owner: 'hassaan@getindigo.ai',
    lastActivityAt: ago(30),
    storyCounts: { total: 5, done: 2 },
  }),
  row('sessions', {
    description: 'In-app sessions composer',
    owner: 'jacob@getindigo.ai',
    lastActivityAt: ago(2),
    storyCounts: { total: 4, done: 1 },
  }),
  row('billing', {
    description: 'Cohort grandfathering',
    owner: 'jacob@getindigo.ai',
    lastActivityAt: ago(100),
    status: 'done',
    storyCounts: { total: 2, done: 2 },
  }),
  row('retired', {
    description: 'Old work',
    owner: 'prs_01KQ2TZQMA8078CHPDWBAFPN0Z',
    lastActivityAt: ago(2000),
    status: 'archived',
  }),
  row('orphan', { description: 'Nobody owns this', updatedAt: ago(10) }),
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
const key = (element: HTMLElement, k: string) => {
  element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
  flushSync();
};
const names = () => all('session-project-item').map((item) => item.getAttribute('data-name'));
const options = () => [...host.querySelectorAll<HTMLElement>('[role="option"]')];

function render(props: Record<string, unknown> = {}) {
  component = mount(ProjectPicker, {
    target: host,
    props: { projects: PROJECTS, selected: null, ...props },
  }) as Record<string, unknown>;
  flushSync();
}

function search(text: string): HTMLInputElement {
  const input = must('session-project-search') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return input;
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  host.remove();
});

describe('the list', () => {
  it('puts "No project" first, then active projects by recency; done and archived are hidden by default', () => {
    render();
    expect(options()[0]?.getAttribute('data-testid')).toBe('session-project-none');
    expect(must('session-project-none').textContent).toContain('No project');
    expect(names()).toEqual(['sessions', 'orphan', 'ads']);
    expect(must('session-project-status-active').getAttribute('aria-pressed')).toBe('true');
    expect(must('session-project-show-all').textContent).toContain('2 done or archived hidden');
  });

  it('All shows done and archived too, tagged, still by recency', () => {
    render();
    click(must('session-project-status-all'));
    expect(names()).toEqual(['sessions', 'orphan', 'ads', 'billing', 'retired']);
    const tags = all('session-project-item').map((item) => item.querySelector('[data-testid="session-project-status"]')?.textContent?.trim() ?? null);
    expect(tags).toEqual([null, null, null, 'done', 'archived']);
    expect(at('session-project-show-all')).toBeNull();
    // The hidden-count affordance is a shortcut to All.
    click(must('session-project-status-active'));
    expect(names()).toHaveLength(3);
    click(must('session-project-show-all'));
    expect(names()).toHaveLength(5);
  });

  it('each row carries initials, "updated … ago", a story bar and its done/total, and a one-line description', () => {
    render();
    const first = all('session-project-item')[0]!;
    expect(first.querySelector('[data-testid="session-project-avatar"]')?.textContent?.trim()).toBe('J');
    expect(first.querySelector('[data-testid="session-project-updated"]')?.textContent?.trim()).toBe('updated 2h ago');
    expect(first.querySelector('[data-testid="session-project-count"]')?.textContent?.trim()).toBe('1/4');
    expect((first.querySelector('[data-testid="session-project-progress"]') as HTMLElement).style.width).toBe('25%');
    const description = first.querySelector('.description') as HTMLElement;
    expect(description.textContent?.trim()).toBe('In-app sessions composer');
    // Not clipped in this layout → no tooltip repeating the text.
    expect(description.hasAttribute('title')).toBe(false);
    // The row itself never repeats the description as a tooltip either.
    expect(first.hasAttribute('title')).toBe(false);
    // An unowned row shows a placeholder mark and says so on hover of the mark only.
    const orphan = all('session-project-item')[1]!;
    expect(orphan.querySelector('[data-testid="session-project-avatar"]')?.textContent?.trim()).toBe('·');
    expect(orphan.querySelector('[data-testid="session-project-avatar"]')?.getAttribute('title')).toBe('No owner');
  });

  it('marks the current pick', () => {
    render({ selected: 'ads' });
    expect(must('session-project-none').getAttribute('aria-selected')).toBe('false');
    const ads = all('session-project-item').find((item) => item.getAttribute('data-name') === 'ads')!;
    expect(ads.getAttribute('aria-selected')).toBe('true');
    expect(ads.querySelector('.check')).not.toBeNull();
  });

  it('shows loading, error and empty states under "No project"', () => {
    render({ projects: [], loading: true });
    expect(at('session-project-loading')).not.toBeNull();
    expect(at('session-project-none')).not.toBeNull();
    if (component) unmount(component);
    render({ projects: [], error: 'boom' });
    expect(must('session-project-error').textContent).toContain('boom');
    if (component) unmount(component);
    render({ projects: [] });
    expect(at('session-project-empty')).not.toBeNull();
  });
});

describe('search', () => {
  it('matches name and description, name first, and says when nothing matches', () => {
    render();
    search('sess');
    expect(names()).toEqual(['sessions']);
    search('report');
    expect(names()).toEqual(['ads']);
    search('zzz');
    expect(names()).toEqual([]);
    expect(must('session-project-no-match').textContent).toContain('"zzz"');
    // "No project" is always there.
    expect(at('session-project-none')).not.toBeNull();
  });

  it('takes the caret on open', async () => {
    render();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.activeElement).toBe(must('session-project-search'));
  });
});

describe('the person filter', () => {
  it('builds chips from the owners of the visible rows, "Mine" first for the viewer', () => {
    render({ viewer: { email: 'Jacob@getindigo.ai' } });
    const chips = all('session-project-person');
    expect(chips.map((chip) => chip.querySelector('.chip-label')?.textContent?.trim())).toEqual(['Mine', 'hassaan']);
    expect(chips[0]?.getAttribute('data-mine')).toBe('true');
    expect(chips[0]?.getAttribute('title')).toBe('jacob@getindigo.ai (you)');
    click(chips[0]!);
    expect(names()).toEqual(['sessions']);
    expect(chips[0]?.getAttribute('aria-pressed')).toBe('true');
    // Mine + All: billing (done) is Jacob's too.
    click(must('session-project-status-all'));
    expect(names()).toEqual(['sessions', 'billing']);
    // The chip set follows the status filter, so the archived owner appears.
    expect(all('session-project-person').map((chip) => chip.querySelector('.chip-label')?.textContent?.trim())).toEqual([
      'Mine',
      'hassaan',
      'Person 01KQ',
    ]);
    // Pressing the chip again shows everyone.
    click(all('session-project-person')[0]!);
    expect(names()).toHaveLength(5);
  });

  it('without a viewer there is no Mine, just people by count', () => {
    render();
    expect(all('session-project-person').map((chip) => chip.querySelector('.chip-label')?.textContent?.trim())).toEqual([
      'hassaan',
      'jacob',
    ]);
    click(all('session-project-person')[0]!);
    expect(names()).toEqual(['ads']);
    // Search and person combine.
    search('meta');
    expect(names()).toEqual(['ads']);
    search('sess');
    expect(names()).toEqual([]);
  });
});

describe('keyboard and picking', () => {
  it('Down / Up walk from "No project" through the rows, Enter picks, clicks pick', () => {
    const onpick = vi.fn();
    render({ onpick });
    const input = must('session-project-search');
    expect(must('session-project-none').getAttribute('data-highlighted')).toBe('true');
    key(input, 'ArrowDown');
    expect(all('session-project-item')[0]?.getAttribute('data-highlighted')).toBe('true');
    key(input, 'ArrowDown');
    key(input, 'Enter');
    expect(onpick).toHaveBeenCalledWith('orphan');
    key(input, 'ArrowUp');
    key(input, 'ArrowUp');
    key(input, 'Enter');
    expect(onpick).toHaveBeenLastCalledWith(null);
    // Wraps.
    key(input, 'ArrowUp');
    expect(all('session-project-item')[2]?.getAttribute('data-highlighted')).toBe('true');
    click(all('session-project-item')[2]!);
    expect(onpick).toHaveBeenLastCalledWith('ads');
    click(must('session-project-none'));
    expect(onpick).toHaveBeenLastCalledWith(null);
  });

  it('a new search resets the highlight to the top', () => {
    render();
    const input = must('session-project-search');
    key(input, 'ArrowDown');
    key(input, 'ArrowDown');
    search('a');
    expect(must('session-project-none').getAttribute('data-highlighted')).toBe('true');
  });
});
