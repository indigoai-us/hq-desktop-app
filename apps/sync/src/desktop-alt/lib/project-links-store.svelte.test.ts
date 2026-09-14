// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
const invoke = vi.hoisted(() => vi.fn());
const captureException = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@sentry/svelte', () => ({ captureException }));
import { projectLinksStore } from './project-links-store.svelte';
import type { ProjectLink } from './session-project-links';

const local: ProjectLink = {
  project: 'launch', projectName: 'launch', projectPath: '/hq/companies/indigo/projects/launch',
  sessions: [{ sessionId: 'native-1', tool: 'codex', phase: 'ended', startedAt: '', title: 'Plan launch' }],
};
it('fetches teammate rows only when expanded and removes them on denied refresh', async () => {
  const link = { ...local, channelId: 'chn_launch' };
  let allowed = true;
  invoke.mockImplementation((command) => {
    if (command === 'project_sessions_read') return allowed ? Promise.resolve({ sessions: [{
      sessionId: 'shared-reader', channelId: 'chn_launch', ownerUid: 'other', isOwner: false,
      title: 'Teammate plan', tool: 'codex', createdAt: 'now', nextSequence: 1,
    }], nextCursor: null }) : Promise.reject(new Error('404'));
    return Promise.resolve([link]);
  });
  projectLinksStore.start(['indigo']);
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')).toHaveLength(1));
  expect(invoke.mock.calls.some(([command]) => command === 'project_sessions_read')).toBe(false);
  projectLinksStore.watchSharedChannel('indigo', link, true);
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')[0].sessions).toHaveLength(2));
  allowed = false;
  await projectLinksStore.refresh();
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')[0].sessions).toEqual(local.sessions));
  projectLinksStore.watchSharedChannel('indigo', link, false);
  const reads = invoke.mock.calls.filter(([command]) => command === 'project_sessions_read').length;
  await projectLinksStore.refresh();
  expect(invoke.mock.calls.filter(([command]) => command === 'project_sessions_read')).toHaveLength(reads);
});
afterEach(() => {
  projectLinksStore.stop();
  invoke.mockReset();
  captureException.mockReset();
  try { window.localStorage?.removeItem('hq.session-project-links.v1'); } catch { /* happy-dom */ }
});

it('hydrates project-session links from disk so the sidebar is not gated on a live fetch', async () => {
  window.localStorage.setItem(
    'hq.session-project-links.v1',
    JSON.stringify({ byCompany: { indigo: [local] }, cachedAt: Date.now() }),
  );
  invoke.mockImplementation(() => new Promise(() => {}));
  projectLinksStore.start(['indigo']);
  expect(projectLinksStore.linksFor('indigo')).toEqual([local]);
  expect(projectLinksStore.loading).toBe(false);
});

it('shows local nested sessions before the channel and provider enrichment finishes', async () => {
  let finish!: (rows: ProjectLink[]) => void;
  const remote = new Promise<ProjectLink[]>((resolve) => { finish = resolve; });
  invoke.mockImplementation((_command, args) => args.localOnly ? Promise.resolve([local]) : remote);
  projectLinksStore.start(['indigo']);
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')).toEqual([local]));
  const enriched = { ...local, channelId: 'chn_launch', projectName: 'Launch' };
  finish([enriched]);
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')).toEqual([enriched]));
});

it('does not resurrect links when a pending request completes after stop', async () => {
  let finish!: (rows: ProjectLink[]) => void;
  invoke.mockReturnValue(new Promise<ProjectLink[]>((resolve) => { finish = resolve; }));
  projectLinksStore.start(['indigo']);
  projectLinksStore.stop();
  finish([local]);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(projectLinksStore.byCompany).toEqual({});
});

it.each(['offline', 'empty'])('keeps local sessions when enrichment is %s', async (mode) => {
  invoke.mockImplementation((_command, args) => args.localOnly ? Promise.resolve([local])
    : mode === 'offline' ? Promise.reject(new Error('offline')) : Promise.resolve([]));
  projectLinksStore.start(['indigo']);
  await projectLinksStore.refresh();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(projectLinksStore.linksFor('indigo')).toEqual([local]);
});

it('does not let delayed enrichment restore an old session phase', async () => {
  let finish!: (rows: ProjectLink[]) => void;
  const remote = new Promise<ProjectLink[]>((resolve) => { finish = resolve; });
  let snapshot = local;
  invoke.mockImplementation((_command, args) => args.localOnly ? Promise.resolve([snapshot]) : remote);
  projectLinksStore.start(['indigo']);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  snapshot = { ...local, sessions: [{ ...local.sessions[0], phase: 'working' }] };
  await projectLinksStore.refresh();
  finish([{ ...local, channelId: 'chn_launch' }]);
  await vi.waitFor(() => expect(projectLinksStore.linksFor('indigo')[0].channelId).toBe('chn_launch'));
  expect(projectLinksStore.linksFor('indigo')[0].sessions[0].phase).toBe('working');
});

it('bounds enrichment concurrency without delaying local company bindings', async () => {
  const finishes: Array<() => void> = [];
  invoke.mockImplementation((_command, args) => args.localOnly ? Promise.resolve([local])
    : new Promise((resolve) => finishes.push(() => resolve([]))));
  const companies = ['a', 'b', 'c', 'd', 'e', 'f'];
  projectLinksStore.start(companies);
  await vi.waitFor(() => expect(Object.keys(projectLinksStore.byCompany)).toHaveLength(6));
  expect(finishes).toHaveLength(4);
  finishes.shift()!();
  await vi.waitFor(() => expect(invoke.mock.calls.filter(([, args]) => !args.localOnly)).toHaveLength(5));
  projectLinksStore.stop();
  finishes.forEach((finish) => finish());
});

it('holds initial loading until enriched links settle and bounds a hung boot', async () => {
  vi.useFakeTimers();
  try {
    invoke.mockImplementation((_command, args) => args.localOnly ? Promise.resolve([local]) : new Promise(() => {}));
    projectLinksStore.start(['indigo']);
    await vi.advanceTimersByTimeAsync(1);
    expect(projectLinksStore.loading).toBe(true);
    await vi.advanceTimersByTimeAsync(10000);
    expect(projectLinksStore.loading).toBe(false);
    expect(projectLinksStore.initialError).toBe(true);
    expect(captureException.mock.calls.some(([, ctx]) => ctx?.tags?.stage === 'boot')).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('reports a failed lookup once, without a second capture on retry', async () => {
  invoke.mockRejectedValue(new Error('offline'));
  projectLinksStore.start(['indigo']);
  await projectLinksStore.refresh();
  await vi.waitFor(() => expect(captureException).toHaveBeenCalled());
  expect(captureException.mock.calls.some(([, ctx]) => ctx?.tags?.stage === 'local')).toBe(true);
  const n = captureException.mock.calls.length;
  await projectLinksStore.refresh();
  expect(captureException).toHaveBeenCalledTimes(n);
});
