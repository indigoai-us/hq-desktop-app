// @vitest-environment happy-dom
import { mount, unmount, tick } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import BotAppsPanel from './BotAppsPanel.svelte';
import { botAppLogo, type BotApp, type SupportedApp } from './bot-apps.js';
let component: ReturnType<typeof mount> | undefined, target: HTMLElement;
afterEach(async () => { if (component) await unmount(component); component = undefined; target?.remove(); });
const settle = async () => { for (let i = 0; i < 5; i++) { await tick(); await Promise.resolve(); } };
const row = (id: string, name: string, status: BotApp['status'], onBot: boolean, extra: Partial<BotApp> = {}): BotApp => ({ id, name, domain: '', description: '', status, detail: `${name} detail`, tools: null, canToggle: true, enabled: onBot, onBot, ...extra });
const rows: BotApp[] = [
  row('linear', 'Linear', 'ready', true),
  row('github', 'GitHub', 'ready', true, { canToggle: false }),
  row('figma', 'Figma', 'attention', true, { enabled: false, canToggle: false, detail: 'The bot reported an expired connection.' }),
  row('notion', 'Notion', 'available', false, { domain: 'mcp.notion.com' }),
  row('slack', 'Slack', 'available', false, { canToggle: false }),
];
const catalog: SupportedApp[] = [
  { id: 'docs', domain: 'docs.example.com', name: 'Docs', description: 'Docs MCP', authClass: 'none', entryId: 'docs' },
  { id: 'cat_notion', domain: 'notion.com', name: 'Notion', description: 'Notes', authClass: 'oauth', entryId: 'cat_notion' },
];
function setup(props: Record<string, unknown>) {
  target = document.createElement('div'); document.body.appendChild(target);
  component = mount(BotAppsPanel, { target, props: props as never });
  return settle();
}
const names = (selector: string) => [...document.querySelectorAll(selector)].map(node => node.querySelector('strong')?.textContent);
const button = (label: string, root: ParentNode = document) => [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
const browseDialog = () => document.querySelector('[role=dialog][aria-label="Browse apps"]');
const card = (testid: string, name: string) => [...document.querySelectorAll(`[data-testid=${testid}]`)].find(node => node.querySelector('strong')?.textContent === name)!;
async function openBrowse() { button('Browse apps')!.click(); await settle(); }
async function searchFor(text: string) {
  const input = browseDialog()!.querySelector<HTMLInputElement>('[aria-label="Search supported apps"]')!;
  input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  return input;
}
it('lists only the company apps this bot has, including ones it reports as needing attention', async () => {
  await setup({ rows, title: 'Company apps' });
  expect(names('[data-testid=bot-app]')).toEqual(['Linear', 'GitHub', 'Figma']);
  expect(card('bot-app', 'Figma').textContent).toContain('Needs attention');
  const head = target.querySelector('.section-head')!;
  expect(head.querySelector('h4')?.textContent).toBe('Company apps');
  expect(head.textContent).toContain('Shared company accounts this bot can use.');
  expect(button('Browse apps', head)).toBeTruthy();
  expect(target.querySelector('[aria-haspopup=listbox]')).toBeNull();
  const search = target.querySelector<HTMLInputElement>('[aria-label="Filter bot apps"]')!;
  search.value = 'git'; search.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  expect(names('[data-testid=bot-app]')).toEqual(['GitHub']);
  expect(target.textContent).toContain('1 of 3 apps');
});
it('Browse apps opens the other company connections and the catalog without duplicates', async () => {
  const onsearch = vi.fn(async () => {});
  await setup({ rows, catalog, onsearch, ontoggle: vi.fn(async () => {}) });
  await openBrowse();
  expect(browseDialog()).not.toBeNull();
  expect(onsearch).toHaveBeenCalledWith('');
  expect(document.querySelector('[aria-label="Company connections"] h4')?.textContent).toBe('Company connections');
  expect(document.querySelector('[aria-label="Connect a new app"] h4')?.textContent).toBe('Connect a new app');
  expect(names('[data-testid=company-app]')).toEqual(['Notion', 'Slack']);
  expect(names('[data-testid=catalog-app]')).toEqual(['Docs']);
  const notion = card('company-app', 'Notion');
  expect(notion.textContent).toContain('Not on this bot');
  expect(notion.textContent).not.toContain('Notion detail');
  expect(notion.textContent).not.toContain('→');
  expect(notion.querySelectorAll('.card-action')).toHaveLength(1);
  expect(button('Add to bot', notion)).toBeTruthy();
  expect(button('Details', card('company-app', 'Slack'))).toBeTruthy();
  expect(button('Connect', card('catalog-app', 'Docs'))).toBeTruthy();
});
it('filters company connections and the catalog together when Search is pressed', async () => {
  const onsearch = vi.fn(async () => {});
  await setup({ rows, catalog, onsearch });
  await openBrowse();
  const input = await searchFor('sla');
  expect(names('[data-testid=company-app]')).toEqual(['Notion', 'Slack']);
  expect(onsearch).toHaveBeenCalledTimes(1);
  button('Search')!.click(); await settle();
  expect(onsearch).toHaveBeenLastCalledWith('sla');
  expect(names('[data-testid=company-app]')).toEqual(['Slack']);
  card('company-app', 'Slack').querySelector<HTMLButtonElement>('[aria-label="Slack details"]')!.click(); await settle();
  expect(browseDialog()).toBeNull();
  expect(document.querySelector('[role=dialog][aria-label="Manage app"]')?.textContent).toContain('Slack detail');
  button('Back to apps')!.click(); await settle();
  expect(browseDialog()).not.toBeNull();
  expect(input.value).toBe('sla');
});
it('adds a company connection to the bot from its Browse card with a pending state', async () => {
  let finish!: () => void;
  const ontoggle = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  await setup({ rows, ontoggle });
  await openBrowse();
  button('Add to bot', card('company-app', 'Notion'))!.click(); await settle();
  const pending = button('Adding…', card('company-app', 'Notion'))!;
  expect(pending.disabled).toBe(true);
  pending.click(); await settle();
  expect(ontoggle).toHaveBeenCalledTimes(1);
  expect(ontoggle).toHaveBeenCalledWith('notion', true);
  finish(); await settle();
  expect(button('Add to bot', card('company-app', 'Notion'))!.disabled).toBe(false);
});
it('returns to Browse with the newly connected app ready to add', async () => {
  const added = row('docs-conn', 'Docs', 'available', false, { domain: 'docs.example.com' });
  let finish!: () => void;
  const ontoggle = vi.fn(async () => {});
  const props = $state<Record<string, unknown>>({ rows, catalog, canConnect: true, ontoggle, onsearch: vi.fn(async () => {}) });
  const onconnect = vi.fn(() => new Promise<{ kind: 'connected'; id: string }>(resolve => { finish = () => { props.rows = [...rows, added]; resolve({ kind: 'connected', id: 'docs-conn' }); }; }));
  props.onconnect = onconnect;
  target = document.createElement('div'); document.body.appendChild(target);
  component = mount(BotAppsPanel, { target, props: props as never }); await settle();
  await openBrowse();
  await searchFor('docs'); button('Search')!.click(); await settle();
  expect(names('[data-testid=company-app]')).toEqual([]);
  button('Connect', card('catalog-app', 'Docs'))!.click(); await settle();
  button('Connect app')!.click(); await settle();
  const pending = button('Connecting…')!;
  expect(pending.disabled).toBe(true);
  pending.click(); await settle();
  expect(onconnect).toHaveBeenCalledTimes(1);
  finish(); await settle();
  expect(browseDialog()).not.toBeNull();
  expect(document.querySelector('[role=dialog][aria-label="Connect app"]')).toBeNull();
  expect(names('[data-testid=company-app]')[0]).toBe('Docs');
  expect(names('[data-testid=catalog-app]')).toEqual([]);
  const docs = card('company-app', 'Docs');
  expect(docs.textContent).toContain('Just connected');
  button('Add to bot', docs)!.click(); await settle();
  expect(ontoggle).toHaveBeenCalledWith('docs-conn', true);
});
it('shows a short empty line when no company apps are connected', async () => {
  await setup({ rows: rows.filter(app => !app.onBot), title: 'Company apps' });
  const empty = target.querySelector('[data-testid=bot-apps-empty]')!;
  expect(empty.tagName).toBe('P');
  expect(empty.textContent).toBe('No company apps are connected to this bot.');
  expect(target.querySelectorAll('[data-testid=bot-app]')).toHaveLength(0);
  expect(target.querySelector('[aria-label="Filter bot apps"]')).toBeNull();
  await openBrowse();
  expect(names('[data-testid=company-app]')).toEqual(['Notion', 'Slack']);
});
it('shows an error instead of the empty line when the access check failed', async () => {
  await setup({ rows: [row('notion', 'Notion', 'unknown', false), row('slack', 'Slack', 'available', false)] });
  expect(target.querySelector('[data-testid=bot-apps-empty]')).toBeNull();
  expect(target.querySelector('[role=alert]')?.textContent).toContain('Could not check this bot’s access to 1 company app.');
});
it('resolves bundled marks for domains, provider IDs and exact app names', () => {
  expect(botAppLogo({ domain: 'mcp.notion.com', name: 'Work notes' }).mark?.title).toBe('Notion');
  expect(botAppLogo({ domain: '', name: 'Work repo', provider: 'factory:github' }).mark?.title).toBe('GitHub');
  expect(botAppLogo({ domain: '', name: 'Google Drive' }).mark?.title).toBe('Google Drive');
  expect(botAppLogo({ domain: '', name: 'Unknown MCP' }).mark).toBeNull();
});
