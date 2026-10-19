// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotAppsPanel from './BotAppsPanel.svelte';
import { botAppLogo, type BotApp, type SupportedApp } from './bot-apps.js';
let component: ReturnType<typeof mount> | undefined, target: HTMLElement;
afterEach(async () => { if (component) await unmount(component); component = undefined; target?.remove(); });
const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); await Promise.resolve(); } };
const row = (id: string, name: string, status: BotApp['status'], enabled: boolean): BotApp => ({ id, name, domain: '', description: '', status, detail: `${name} detail`, tools: null, canToggle: true, enabled });
const rows: BotApp[] = [
  row('linear', 'Linear', 'ready', true),
  row('github', 'GitHub', 'ready', true),
  row('notion', 'Notion', 'available', false),
  row('figma', 'Figma', 'attention', false),
  row('slack', 'Slack', 'unknown', false),
  row('attention:sentry', 'Sentry', 'attention', false),
];
const catalog: SupportedApp[] = [{ id: 'docs', domain: 'docs.example.com', name: 'Docs', description: 'Docs MCP', authClass: 'none', entryId: 'docs' }];
function setup(props: Record<string, unknown>) {
  target = document.createElement('div'); document.body.appendChild(target);
  component = mount(BotAppsPanel, { target, props: props as never });
  return settle();
}
const names = (selector: string) => [...document.querySelectorAll(selector)].map(node => node.querySelector('strong')?.textContent);
const button = (label: string) => [...document.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
it('lists only the company apps this bot has', async () => {
  await setup({ rows });
  expect(names('[data-testid=bot-app]')).toEqual(['Linear', 'GitHub', 'Sentry']);
  expect(target.textContent).toContain('3 apps');
  expect(target.querySelector('[aria-haspopup=listbox]')).toBeNull();
  const search = target.querySelector<HTMLInputElement>('[aria-label="Filter bot apps"]')!;
  search.value = 'git'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  expect(names('[data-testid=bot-app]')).toEqual(['GitHub']);
  expect(target.textContent).toContain('1 of 3 apps');
});
it('Browse apps opens the rest of the company connections and the catalog', async () => {
  const onsearch = vi.fn(async () => {});
  await setup({ rows, catalog, onsearch });
  button('Browse apps')!.click(); await settle();
  const dialog = document.querySelector('[role=dialog][aria-label="Browse apps"]')!;
  expect(dialog).not.toBeNull();
  expect(onsearch).toHaveBeenCalledWith('');
  expect(names('[data-testid=company-app]')).toEqual(['Notion', 'Figma', 'Slack']);
  expect(names('[data-testid=catalog-app]')).toEqual(['Docs']);
  const search = dialog.querySelector<HTMLInputElement>('[aria-label="Search supported apps"]')!;
  search.value = 'fig'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  expect(names('[data-testid=company-app]')).toEqual(['Figma']);
  document.querySelector<HTMLButtonElement>('[data-testid=company-app]')!.click(); await settle();
  expect(document.querySelector('[role=dialog][aria-label="Browse apps"]')).toBeNull();
  expect(document.querySelector('[role=dialog][aria-label="Manage app"]')?.textContent).toContain('Figma detail');
  button('Back to apps')!.click(); await settle();
  expect(document.querySelector('[role=dialog][aria-label="Browse apps"]')).not.toBeNull();
  expect(search.value).toBe('fig');
});
it('adds a company connection to the bot from the browse view with a pending state', async () => {
  let finish!: () => void;
  const ontoggle = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await setup({ rows, ontoggle });
  button('Browse apps')!.click(); await settle();
  [...document.querySelectorAll<HTMLButtonElement>('[data-testid=company-app]')].find(node => node.textContent?.includes('Notion'))!.click(); await settle();
  button('Add to bot')!.click(); await settle();
  const saving = button('Saving…')!;
  expect(saving.disabled).toBe(true);
  saving.click(); await settle();
  expect(ontoggle).toHaveBeenCalledTimes(1);
  expect(ontoggle).toHaveBeenCalledWith('notion', true);
  finish(); await settle();
});
it('shows a short empty state with Browse apps when no company apps are connected', async () => {
  const onsearch = vi.fn(async () => {});
  await setup({ rows: rows.filter(app => !app.enabled && !app.id.startsWith('attention:')), onsearch });
  const empty = target.querySelector('[data-testid=bot-apps-empty]')!;
  expect(empty.textContent).toContain('No company apps are connected to this bot.');
  expect(target.querySelectorAll('[data-testid=bot-app]')).toHaveLength(0);
  expect(target.querySelector('[aria-label="Filter bot apps"]')).toBeNull();
  [...empty.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Browse apps')!.click(); await settle();
  expect(document.querySelector('[role=dialog][aria-label="Browse apps"]')).not.toBeNull();
  expect(names('[data-testid=company-app]')).toEqual(['Notion', 'Figma', 'Slack']);
});
it('resolves bundled marks for domains, provider IDs and exact app names', () => {
  expect(botAppLogo({ domain: 'mcp.notion.com', name: 'Work notes' }).mark?.title).toBe('Notion');
  expect(botAppLogo({ domain: '', name: 'Work repo', provider: 'factory:github' }).mark?.title).toBe('GitHub');
  expect(botAppLogo({ domain: '', name: 'Google Drive' }).mark?.title).toBe('Google Drive');
  expect(botAppLogo({ domain: '', name: 'Unknown MCP' }).mark).toBeNull();
});
