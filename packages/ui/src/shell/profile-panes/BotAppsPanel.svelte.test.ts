// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it } from 'vitest';
import BotAppsPanel from './BotAppsPanel.svelte';
import { botAppLogo, type BotApp } from './bot-apps.js';
let component: ReturnType<typeof mount>, target: HTMLElement;
afterEach(async () => { if (component) await unmount(component); target?.remove(); });
const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); await Promise.resolve(); } };
it('filters every status, combines search, and supports keyboard reset', async () => {
  target = document.createElement('div'); document.body.appendChild(target);
  const statuses = ['ready', 'available', 'attention', 'unknown'] as const;
  const rows: BotApp[] = statuses.map((status, i) => ({ id: status, name: ['GitHub', 'Notion', 'Figma', 'Linear'][i], domain: '', description: '', status, detail: '', tools: null, canToggle: false, enabled: false }));
  component = mount(BotAppsPanel, { target, props: { rows } }); await settle();
  expect(target.querySelectorAll('[data-logo=mark]')).toHaveLength(4);
  const trigger = () => target.querySelector<HTMLButtonElement>('[aria-haspopup=listbox]')!;
  for (const status of statuses) {
    trigger().click(); await settle();
    target.querySelector<HTMLElement>(`[role=option][data-value=${status}]`)!.click(); await settle();
    expect(target.querySelectorAll('[data-testid=bot-app]')).toHaveLength(1);
    expect(target.querySelector('[role=listbox]')).toBeNull();
  }
  trigger().click(); await settle();
  const list = target.querySelector('[role=listbox]')!;
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle();
  expect(target.querySelectorAll('[data-testid=bot-app]')).toHaveLength(4);
  const search = target.querySelector<HTMLInputElement>('[aria-label="Filter bot apps"]')!;
  search.value = 'notion'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  expect(target.querySelectorAll('[data-testid=bot-app]')).toHaveLength(1);
  expect(target.querySelector('[data-testid=bot-app]')?.textContent).toContain('Notion');
});
it('resolves bundled marks for domains, provider IDs and exact app names', () => {
  expect(botAppLogo({ domain: 'mcp.notion.com', name: 'Work notes' }).mark?.title).toBe('Notion');
  expect(botAppLogo({ domain: '', name: 'Work repo', provider: 'factory:github' }).mark?.title).toBe('GitHub');
  expect(botAppLogo({ domain: '', name: 'Google Drive' }).mark?.title).toBe('Google Drive');
  expect(botAppLogo({ domain: '', name: 'Unknown MCP' }).mark).toBeNull();
});
