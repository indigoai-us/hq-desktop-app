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
