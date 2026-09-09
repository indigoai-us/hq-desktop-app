import { describe, it, expect, vi } from 'vitest';
const api = vi.hoisted(() => ({ identity: { whoami: vi.fn(), getProfile: vi.fn() }, messaging: { listContacts: vi.fn() } }));
vi.mock('@hq/platform', () => ({ createSyncPlatformAdapter: () => api }));
import { loadSessionStarter } from './session-starter';
describe('starter profile attribution', () => {
  it('uses the matching signed-in profile', async () => {
    api.identity.whoami.mockResolvedValue({ ok: true, value: { email: 'alex@example.test', personUid: 'prs_alex' } });
    api.identity.getProfile.mockResolvedValue({ ok: true, value: { profile: { displayName: 'Alex', description: 'Designer' } } });
    expect(await loadSessionStarter('alex@example.test')).toMatchObject({ name: 'Alex', description: 'Designer' });
  });
  it('does not attribute another session to the viewer', async () => {
    api.identity.whoami.mockResolvedValue({ ok: true, value: { email: 'viewer@example.test' } });
    api.messaging.listContacts.mockResolvedValue({ ok: true, value: [{ email: 'alex@example.test', displayName: 'Alex', avatarUrl: 'https://untrusted.example/photo.png' }] });
    expect(await loadSessionStarter('alex@example.test')).toMatchObject({ name: 'Alex', avatarUrl: null });
    expect(await loadSessionStarter('missing@example.test')).toBeNull();
  });
});

it('deduplicates reads and restores an account-partitioned profile after remount', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  const { configureSessionStarterCache, cachedSessionStarter } = await import('./session-starter');
  configureSessionStarterCache('account-a');
  api.identity.whoami.mockClear();
  api.identity.whoami.mockResolvedValue({ ok: true, value: { email: 'alex@example.test' } });
  api.identity.getProfile.mockResolvedValue({ ok: true, value: { profile: { displayName: 'Alex' } } });
  await Promise.all([loadSessionStarter('alex@example.test'), loadSessionStarter('alex@example.test')]);
  expect(api.identity.whoami).toHaveBeenCalledTimes(1);
  configureSessionStarterCache(null);
  expect(cachedSessionStarter('alex@example.test')).toBeNull();
  configureSessionStarterCache('account-a');
  expect(cachedSessionStarter('alex@example.test')?.name).toBe('Alex');
  await loadSessionStarter('alex@example.test');
  expect(api.identity.whoami).toHaveBeenCalledTimes(1);
  configureSessionStarterCache('account-b');
  expect(cachedSessionStarter('alex@example.test')).toBeNull();
  configureSessionStarterCache(null);
  vi.unstubAllGlobals();
});

it('persists decoded thumbnail bytes instead of an expiring remote URL', async () => {
  const storage = new Map<string, string>();
  const thumbnail = 'data:image/png;base64,aW1hZ2U=';
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('Image', class { onload: (() => void) | null = null; onerror = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => thumbnail }) });
  const { configureSessionStarterCache, cachedSessionStarter } = await import('./session-starter');
  configureSessionStarterCache('image-account');
  api.identity.whoami.mockResolvedValue({ ok: true, value: { email: 'alex@example.test' } });
  api.identity.getProfile.mockResolvedValue({ ok: true, value: { profile: { displayName: 'Alex', avatarUrl: 'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com/members/alex/avatar.png' } } });
  expect((await loadSessionStarter('alex@example.test'))?.avatarUrl).toBe(thumbnail);
  configureSessionStarterCache(null);
  configureSessionStarterCache('image-account');
  expect(cachedSessionStarter('alex@example.test')?.avatarUrl).toBe(thumbnail);
  configureSessionStarterCache(null);
  vi.unstubAllGlobals();
});

it('clears the in-memory starter cache from the host sign-out path', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const shell = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop-alt/HqWorkWorkShell.svelte'), 'utf8');
  expect(shell).toMatch(/authAccountId = null;\s*configureSessionStarterCache\(null\);/);
});
