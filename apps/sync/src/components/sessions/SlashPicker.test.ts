// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('svelte', async () => {
  // @ts-expect-error use Svelte's browser entry in happy-dom.
  return await import('../../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import SessionComposer from './SessionComposer.svelte';
import type { SkillCatalog } from './slash-commands';

const CATALOG: SkillCatalog = {
  workers: [
    { id: 'designer', name: 'Designer', description: 'Designs product interfaces', company: null,
      skills: [{ name: 'mockup', description: 'Draw screens', tags: ['design'], invoke: '/run designer mockup' }] },
    { id: 'analyst', name: 'Analyst', description: 'Finds useful patterns', company: 'indigo', skills: [] },
  ],
  skills: [
    { name: 'Capture', description: 'Capture company knowledge', scope: 'company:indigo', tags: ['knowledge', 'ops'], invoke: '/indigo:capture', skillUid: 'skl_capture', groupId: 'grp_ops', groupName: 'Operations', companyWide: false },
    { name: 'Share', description: 'Share a file', scope: 'company:indigo', tags: ['ops'], invoke: '/indigo:share', skillUid: 'skl_share', groupId: null, groupName: null, companyWide: true },
    { name: 'DM', description: 'Send a message', scope: 'personal', tags: ['people'], invoke: '/personal:dm' },
    { name: 'Handoff', description: 'End the session', scope: 'core', tags: ['session'], invoke: '/handoff' },
    { name: 'Gmail', description: 'Work with Gmail', scope: 'package', tags: ['google'], invoke: '/gws-gmail' },
  ],
};

let host: HTMLElement;
let component: Record<string, unknown> | null = null;
const one = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...host.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const must = (id: string) => { const found = one(id); if (!found) throw new Error(`missing ${id}`); return found; };
const click = (el: HTMLElement) => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); flushSync(); };
function render(props: Record<string, unknown> = {}) {
  component = mount(SessionComposer, { target: host, props: { company: 'indigo', catalog: CATALOG, ...props } }) as Record<string, unknown>;
  flushSync();
}
function type(value: string) {
  const input = must('session-composer-input') as HTMLTextAreaElement;
  input.value = value; input.setSelectionRange?.(value.length, value.length);
  input.dispatchEvent(new Event('input', { bubbles: true })); flushSync(); return input;
}
function setSelect(id: string, value: string) {
  const select = must(id) as HTMLSelectElement; select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true })); flushSync();
}
const names = () => all('session-slash-item').map((row) => row.querySelector('.name')?.textContent?.trim());

beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
afterEach(() => { if (component) unmount(component); component = null; host.remove(); });

describe('two-tab picker', () => {
  it('uses an opaque surface so transcript text cannot bleed through', () => {
    const source = readFileSync('src/components/sessions/SlashPicker.svelte', 'utf8');
    const pickerRule = source.match(/\.slash-picker\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    expect(pickerRule).toContain('background: var(--v4-surface-solid');
    expect(pickerRule).not.toContain('background: var(--v4-popover-strong');
  });

  it('opens on Skills and excludes All, Recent, Commands, and scope chips', () => {
    render(); type('/');
    const tabs = [...must('session-slash-tabs').querySelectorAll('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual(['Skills', 'Workers']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    expect(names()).toEqual(['Capture', 'Share', 'DM', 'Handoff', 'Gmail']);
    expect(host.textContent).not.toContain('Recent');
    expect(host.textContent).not.toContain('Commands');
    expect(one('session-slash-scope')).toBeNull();
  });

  it('searches the active tab and workers select directly without drilling down', () => {
    render(); type('/know'); expect(names()).toEqual(['Capture']);
    click(must('session-slash-tab-workers'));
    const search = must('session-slash-search') as HTMLInputElement;
    search.value = 'design'; search.dispatchEvent(new Event('input', { bubbles: true })); flushSync();
    expect(names()).toEqual(['Designer']);
    click(all('session-slash-item')[0]!);
    expect(one('session-slash-menu')).toBeNull();
    expect(must('session-command-chip').getAttribute('data-kind')).toBe('worker');
    expect(must('session-command-chip').textContent).toContain('Designer');
    expect((must('session-composer-input') as HTMLTextAreaElement).value).toBe('');
  });

  it('combines group, tag, and search filters with AND semantics and clears them', () => {
    render(); type('/');
    setSelect('session-slash-group', 'grp_ops'); expect(names()).toEqual(['Capture']);
    setSelect('session-slash-tag-filter', 'people'); expect(names()).toEqual([]);
    click(must('session-slash-clear')); expect(names()).toEqual(['Capture', 'Share', 'DM', 'Handoff', 'Gmail']);
    setSelect('session-slash-group', 'company-wide'); expect(names()).toEqual(['Share']);
  });

  it('keeps local skills and tag filtering when group metadata is offline', () => {
    render({ groupMetadataAvailable: false }); type('/');
    expect(names()).toHaveLength(5);
    expect((must('session-slash-group') as HTMLSelectElement).disabled).toBe(true);
    expect(must('session-slash-metadata-note').textContent).toContain('Local skills still work');
    setSelect('session-slash-tag-filter', 'session'); expect(names()).toEqual(['Handoff']);
  });

  it('keeps arrow and Enter keyboard selection', () => {
    render(); const input = type('/');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); flushSync();
    expect(must('session-command-chip').textContent).toContain('Share');
  });
});

describe('route pills and payloads', () => {
  it('sends a skill with optional arguments and leaves the prompt when the pill is removed', () => {
    const onsend = vi.fn(); render({ onsend }); type('/cap'); click(all('session-slash-item')[0]!);
    expect(must('session-command-chip').getAttribute('data-kind')).toBe('skill');
    type('this customer insight'); click(must('session-command-remove'));
    expect((must('session-composer-input') as HTMLTextAreaElement).value).toBe('this customer insight');
    type('/cap'); click(all('session-slash-item')[0]!); type('this customer insight'); click(must('session-composer-send'));
    expect(onsend).toHaveBeenCalledWith('/indigo:capture this customer insight', [], [], []);
  });

  it('requires a worker prompt and serializes /run worker -- prompt', () => {
    const onsend = vi.fn(); render({ onsend }); type('/'); click(must('session-slash-tab-workers')); click(all('session-slash-item')[1]!);
    expect((must('session-composer-send') as HTMLButtonElement).disabled).toBe(true);
    type('Review the onboarding flow'); click(must('session-composer-send'));
    expect(onsend).toHaveBeenCalledWith('/run designer -- Review the onboarding flow', [], [], []);
  });

  it('preserves manually typed slash commands verbatim', () => {
    const onsend = vi.fn(); render({ onsend }); const input = type('/compact now');
    expect(one('session-slash-menu')).toBeNull();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); flushSync();
    expect(onsend).toHaveBeenCalledWith('/compact now', [], [], []);
  });
});
