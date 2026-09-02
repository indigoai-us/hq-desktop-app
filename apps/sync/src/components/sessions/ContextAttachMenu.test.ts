// @vitest-environment happy-dom
/**
 * The `+` menu and its chips, mounted through the composer with stub loaders:
 * a meeting pick becomes a chip whose text is read at once, chips are removable,
 * the cap holds at four, and the send carries exactly the loaded chips. The
 * company pill's project level and the /startwork toggle live here too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('svelte', async () => {
  // @ts-expect-error Vitest needs Svelte's browser entry for happy-dom mounts.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionComposer from './SessionComposer.svelte';
import type { ContextLoaders, ReferenceText, VaultEntry } from './context-attachments';

const MEETINGS = [
  { id: 'm1', title: 'Weekly sync', date: '2026-09-01T10:00:00Z', path: '/HQ/companies/indigo/sources/meetings/m1.md', participants: ['Corey', 'Jacob'], summary: 'plans' },
  { id: 'm2', title: 'Design review', date: '2026-08-28T10:00:00Z', path: '/HQ/companies/indigo/sources/meetings/m2.md', participants: ['Alex'], summary: 'screens' },
];
const SIGNALS = [
  { id: 's1', kind: 'decision', title: 'Ship Friday', date: '2026-09-01', path: '/HQ/companies/indigo/signals/s1.md', snippet: 'we ship' },
  { id: 's2', kind: 'action_item', title: 'Write the brief', date: null, path: '/HQ/companies/indigo/signals/s2.md', snippet: '' },
  { id: 's3', kind: 'decision', title: 'Keep the name', date: null, path: '/HQ/companies/indigo/signals/s3.md', snippet: '' },
];
const ROOT: VaultEntry[] = [
  { path: '/HQ/companies/indigo/knowledge', name: 'knowledge', kind: 'dir', bytes: 0, modifiedAt: null },
  { path: '/HQ/companies/indigo/README.md', name: 'README.md', kind: 'file', bytes: 12, modifiedAt: null },
];
const KNOWLEDGE: VaultEntry[] = [
  { path: '/HQ/companies/indigo/knowledge/brief.md', name: 'brief.md', kind: 'file', bytes: 40, modifiedAt: null },
];

function loaders(overrides: Partial<ContextLoaders> = {}): ContextLoaders {
  return {
    meetings: vi.fn(async () => MEETINGS),
    signals: vi.fn(async () => SIGNALS),
    vaultFiles: vi.fn(async (_company: string, prefix: string) => (prefix === 'knowledge' ? KNOWLEDGE : ROOT)),
    referenceText: vi.fn(async (path: string) => ({ path, text: `text of ${path}`, truncated: path.endsWith('m2.md') })),
    ...overrides,
  };
}

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
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync();
};

function render(props: Record<string, unknown> = {}) {
  component = mount(SessionComposer, {
    target: host,
    props: {
      companies: [{ slug: 'indigo', displayName: 'Indigo' }, { slug: 'ridge', displayName: 'Ridge' }],
      company: 'indigo',
      context: loaders(),
      ...props,
    },
  }) as Record<string, unknown>;
  flushSync();
}

function type(text: string): HTMLTextAreaElement {
  const input = must('session-composer-input') as HTMLTextAreaElement;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return input;
}

async function attachMeeting(index: number) {
  click(must('session-composer-attach'));
  click(must('session-attach-meeting'));
  await settle();
  click(all('session-attach-meeting-row')[index]!);
  await settle();
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

describe('the + menu', () => {
  it('opens on the + button with the five entries and closes on Escape', () => {
    render();
    expect(at('session-attach-menu')).toBeNull();
    click(must('session-composer-attach'));
    const menu = must('session-attach-menu');
    for (const id of ['session-attach-image', 'session-attach-meeting', 'session-attach-signal', 'session-attach-vault', 'session-attach-path']) {
      expect(menu.querySelector(`[data-testid="${id}"]`), id).not.toBeNull();
    }
    expect(menu.closest('[data-testid="session-composer"]')).not.toBeNull();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    flushSync();
    expect(at('session-attach-menu')).toBeNull();
  });

  it('Image… opens the existing file picker', () => {
    render();
    const file = must('session-composer-file') as HTMLInputElement;
    const opened = vi.spyOn(file, 'click').mockImplementation(() => {});
    click(must('session-composer-attach'));
    click(must('session-attach-image'));
    expect(opened).toHaveBeenCalledTimes(1);
    expect(at('session-attach-menu')).toBeNull();
  });

  it('disables the HQ entries without a company', () => {
    render({ company: null, companies: [] });
    click(must('session-composer-attach'));
    expect((must('session-attach-meeting') as HTMLButtonElement).disabled).toBe(true);
    expect((must('session-attach-vault') as HTMLButtonElement).disabled).toBe(true);
    expect((must('session-attach-image') as HTMLButtonElement).disabled).toBe(false);
    expect(at('session-attach-no-company')).not.toBeNull();
  });

  it('Meeting… lists recent meetings, searchable, and a pick becomes a chip "Meeting · title · date"', async () => {
    const context = loaders();
    render({ context });
    click(must('session-composer-attach'));
    click(must('session-attach-meeting'));
    await settle();
    expect(context.meetings).toHaveBeenCalledWith('indigo');
    expect(all('session-attach-meeting-row').map((row) => row.textContent)).toHaveLength(2);
    const search = must('session-attach-search') as HTMLInputElement;
    search.value = 'alex';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(all('session-attach-meeting-row')).toHaveLength(1);
    click(all('session-attach-meeting-row')[0]!);
    await settle();
    expect(at('session-attach-menu')).toBeNull();
    const chip = must('session-context-chip');
    expect(chip.textContent).toContain('Meeting · Design review · 2026-08-28');
    expect(chip.getAttribute('data-kind')).toBe('meeting');
    expect(context.referenceText).toHaveBeenCalledWith('/HQ/companies/indigo/sources/meetings/m2.md', 6000);
    // m2 is the truncated one.
    expect(at('session-context-truncated')).not.toBeNull();
    expect(must('session-context-size').textContent?.trim()).toBe('1 of 4 · 51 / 24k chars');
  });

  it('Signal… groups by kind', async () => {
    render();
    click(must('session-composer-attach'));
    click(must('session-attach-signal'));
    await settle();
    expect(all('session-attach-signal-kind').map((node) => node.textContent?.trim())).toEqual(['Decisions', 'Action items']);
    expect(all('session-attach-signal-row')).toHaveLength(3);
    click(all('session-attach-signal-row')[1]!);
    await settle();
    expect(must('session-context-chip').textContent).toContain('Signal · Keep the name · decision');
  });

  it('Vault file… browses with breadcrumbs, descends into folders, and attaches a file', async () => {
    const context = loaders();
    render({ context });
    click(must('session-composer-attach'));
    click(must('session-attach-vault'));
    await settle();
    expect(context.vaultFiles).toHaveBeenLastCalledWith('indigo', '', '');
    expect(all('session-attach-crumb').map((crumb) => crumb.textContent?.trim())).toEqual(['indigo']);
    const rows = all('session-attach-vault-row');
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual(['dir', 'file']);
    click(rows[0]!);
    await settle();
    expect(context.vaultFiles).toHaveBeenLastCalledWith('indigo', 'knowledge', '');
    expect(all('session-attach-crumb').map((crumb) => crumb.textContent?.trim())).toEqual(['indigo', 'knowledge']);
    // The search re-lists with the query.
    const search = must('session-attach-search') as HTMLInputElement;
    search.value = 'bri';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(context.vaultFiles).toHaveBeenLastCalledWith('indigo', 'knowledge', 'bri');
    click(all('session-attach-vault-row')[0]!);
    await settle();
    expect(must('session-context-chip').textContent).toContain('File · brief.md');
    // The crumb goes back to the root.
    click(must('session-composer-attach'));
    click(must('session-attach-vault'));
    await settle();
    click(all('session-attach-vault-row')[0]!);
    await settle();
    click(all('session-attach-crumb')[0]!);
    await settle();
    expect(context.vaultFiles).toHaveBeenLastCalledWith('indigo', '', '');
  });

  it('Paste path attaches a path inside HQ', async () => {
    render();
    click(must('session-composer-attach'));
    click(must('session-attach-path'));
    const input = must('session-attach-path-input') as HTMLInputElement;
    expect((must('session-attach-path-submit') as HTMLButtonElement).disabled).toBe(true);
    input.value = 'companies/indigo/knowledge/a.md';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    expect(must('session-context-chip').textContent).toContain('Path · a.md');
  });
});

describe('chips', () => {
  it('are removable and the send carries exactly the loaded chips, after the text', async () => {
    const onsend = vi.fn();
    render({ onsend });
    await attachMeeting(0);
    await attachMeeting(1);
    expect(all('session-context-chip')).toHaveLength(2);
    click(all('session-context-remove')[0]!);
    expect(all('session-context-chip')).toHaveLength(1);
    type('summarise');
    must('session-composer-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    flushSync();
    expect(onsend).toHaveBeenCalledTimes(1);
    const [text, images, mentions, attachments] = onsend.mock.calls[0]!;
    expect(text).toBe('summarise');
    expect(images).toEqual([]);
    expect(mentions).toEqual([]);
    expect(attachments).toEqual([
      {
        kind: 'meeting',
        title: 'Design review',
        path: '/HQ/companies/indigo/sources/meetings/m2.md',
        subtitle: '2026-08-28',
        text: 'text of /HQ/companies/indigo/sources/meetings/m2.md',
        truncated: true,
      },
    ]);
    // The row clears with the send.
    expect(at('session-context-chips')).toBeNull();
  });

  it('caps at four and says so', async () => {
    const context = loaders({
      meetings: vi.fn(async () =>
        Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, title: `M${i}`, date: null, path: `/HQ/m${i}.md`, participants: [], summary: '' })),
      ),
    });
    render({ context });
    for (let i = 0; i < 4; i += 1) await attachMeeting(i);
    expect(all('session-context-chip')).toHaveLength(4);
    expect(must('session-context-size').textContent).toContain('4 of 4');
    await attachMeeting(4);
    expect(all('session-context-chip')).toHaveLength(4);
    expect(must('session-context-error').textContent).toContain('At most 4 attachments');
  });

  it('refuses a chip that would push the context past 24k characters', async () => {
    const context = loaders({
      referenceText: vi.fn(async (path: string) => ({ path, text: 'x'.repeat(6000), truncated: true })),
      meetings: vi.fn(async () =>
        Array.from({ length: 5 }, (_, i) => ({ id: `m${i}`, title: `M${i}`, date: null, path: `/HQ/m${i}.md`, participants: [], summary: '' })),
      ),
    });
    render({ context });
    for (let i = 0; i < 4; i += 1) await attachMeeting(i);
    expect(must('session-context-size').textContent?.trim()).toBe('4 of 4 · 24k / 24k chars');
    // A fifth is stopped by the count cap; drop one and re-read a bigger one.
    click(all('session-context-remove')[0]!);
    (context.referenceText as ReturnType<typeof vi.fn>).mockImplementationOnce(async (path: string) => ({ path, text: 'y'.repeat(6001), truncated: false }));
    await attachMeeting(4);
    expect(all('session-context-chip')).toHaveLength(3);
    expect(must('session-context-error').textContent).toContain('24k-character budget');
  });

  it('a chip that cannot be read is dropped with the reason', async () => {
    const context = loaders({ referenceText: vi.fn(async () => { throw new Error('outside HQ'); }) });
    render({ context });
    await attachMeeting(0);
    expect(at('session-context-chip')).toBeNull();
    expect(must('session-context-error').textContent).toContain('outside HQ');
  });

  it('blocks the send while a chip is still being read', async () => {
    let release: (() => void) | null = null;
    const context = loaders({
      referenceText: vi.fn(
        () =>
          new Promise<ReferenceText>((resolve) => {
            release = () => resolve({ path: '/p', text: 'late', truncated: false });
          }),
      ),
    });
    const onsend = vi.fn();
    render({ context, onsend });
    click(must('session-composer-attach'));
    click(must('session-attach-meeting'));
    await settle();
    click(all('session-attach-meeting-row')[0]!);
    flushSync();
    type('go');
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    release!();
    await settle();
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('the company pill: project level and the /startwork toggle', () => {
  const PROJECTS = [
    { name: 'sessions', description: 'In-app sessions', branchName: 'feat/x', path: '/HQ/companies/indigo/projects/sessions', storyCounts: { total: 12, done: 3 }, updatedAt: null },
    { name: 'ads', description: '', branchName: null, path: '/HQ/companies/indigo/projects/ads', storyCounts: { total: 2, done: 2 }, updatedAt: null },
  ];

  it('picking a company opens the Project pane; "No project" is first and rows show done/total', () => {
    const oncompany = vi.fn();
    const onproject = vi.fn();
    render({ projects: PROJECTS, oncompany, onproject });
    click(must('session-pill-company'));
    expect(must('session-menu-company').getAttribute('data-pane')).toBe('companies');
    click(all('session-menu-company-item')[1]!);
    expect(oncompany).toHaveBeenCalledWith('ridge');
    expect(must('session-menu-company').getAttribute('data-pane')).toBe('projects');
    const picker = must('session-project-picker');
    expect(picker.firstElementChild?.getAttribute('data-testid')).toBe('session-project-none');
    expect(all('session-project-count').map((node) => node.textContent?.trim())).toEqual(['3/12', '2/2']);
    click(all('session-project-item')[0]!);
    expect(onproject).toHaveBeenCalledWith('sessions');
    expect(at('session-menu-company')).toBeNull();
  });

  it('names the project on the pill and lets "No project" clear it', () => {
    const onproject = vi.fn();
    render({ projects: PROJECTS, project: 'sessions', onproject });
    expect(must('session-pill-company').textContent).toContain('Indigo · sessions');
    click(must('session-pill-company'));
    click(must('session-menu-project-open'));
    click(must('session-project-none'));
    expect(onproject).toHaveBeenCalledWith(null);
  });

  it('the toggle reads its state and reports the flip without closing the menu', () => {
    const onstartworktoggle = vi.fn();
    render({ startworkEnabled: true, onstartworktoggle });
    click(must('session-pill-company'));
    const toggle = must('session-menu-startwork-toggle');
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.textContent).toContain('Run /startwork on first message');
    click(toggle);
    expect(onstartworktoggle).toHaveBeenCalledWith(false);
    expect(at('session-menu-company')).not.toBeNull();
  });

  it('shows loading, error and empty states in the project pane', () => {
    render({ projects: [], projectsLoading: true });
    click(must('session-pill-company'));
    click(must('session-menu-project-open'));
    expect(at('session-project-loading')).not.toBeNull();
    if (component) unmount(component);
    component = null;
    render({ projects: [], projectsError: 'no manifest' });
    click(must('session-pill-company'));
    click(must('session-menu-project-open'));
    expect(must('session-project-error').textContent).toContain('no manifest');
    if (component) unmount(component);
    component = null;
    render({ projects: [] });
    click(must('session-pill-company'));
    click(must('session-menu-project-open'));
    expect(at('session-project-empty')).not.toBeNull();
    click(must('session-menu-project-back'));
    expect(must('session-menu-company').getAttribute('data-pane')).toBe('companies');
  });
});
