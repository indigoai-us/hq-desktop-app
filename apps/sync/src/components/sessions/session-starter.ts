import { invoke } from '@tauri-apps/api/core';
import { createSyncPlatformAdapter } from '@hq/platform';
import { paintableAvatarSrc } from '../../../../../packages/ui/src/avatars/csp-image-src';
export interface SessionStarter { name: string; email?: string; description?: string; avatarUrl: string | null }
/** Resolve attribution without substituting the current viewer for another starter. */
async function fetchSessionStarter(identity: string): Promise<SessionStarter | null> {
  try {
    const adapter = createSyncPlatformAdapter({ invoke });
    const self = await adapter.identity.whoami();
    if (self.ok && [self.value.email, self.value.personUid].some(value => value?.toLowerCase() === identity.toLowerCase())) {
      const result = await adapter.identity.getProfile();
      if (!result.ok) return null;
      const profile = result.value.profile;
      return { name: profile?.displayName || (result.ok ? result.value.entityName : null) || self.value.displayName || identity,
        email: self.value.email, description: profile?.description,
        avatarUrl: paintableAvatarSrc(profile?.avatarUrl || (profile?.avatarBase64 ? `data:image/png;base64,${profile.avatarBase64}` : null)) };
    }
    const result = await adapter.messaging.listContacts();
    if (!result.ok || !Array.isArray(result.value)) return null;
    const row = result.value.find((item: any) => item && [item.email, item.personUid, item.uid].some((value: unknown) => typeof value === 'string' && value.toLowerCase() === identity.toLowerCase())) as Record<string, unknown> | undefined;
    if (!row) return null;
    const str = (key: string) => typeof row[key] === 'string' ? row[key] as string : undefined;
    return { name: str('displayName') || str('name') || identity, email: str('email'), description: str('description'), avatarUrl: paintableAvatarSrc(str('avatarUrl')) };
  } catch { return null; }
}


const MAX_AGE = 24 * 60 * 60 * 1000;
const REFRESH_AFTER = 5 * 60 * 1000;
let account: string | null = null;
let epoch = 0;
type Entry = { value: SessionStarter; savedAt: number };
let cache: Record<string, Entry> = {};
const pending = new Map<string, Promise<SessionStarter | null>>();
const key = (id: string) => id.trim().toLowerCase();
const storageKey = () => `hq.session-avatars.v1:${account}`;

/** Called at the native auth boundary, before mounting any session headers. */
export function configureSessionStarterCache(accountId: string | null): void {
  if (account === accountId) return;
  account = accountId;
  epoch += 1;
  cache = {};
  pending.clear();
  if (!account) return;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || '{}');
    for (const [id, entry] of Object.entries(saved).slice(-40)) {
      const row = entry as Entry;
      if (!row || typeof row.savedAt !== 'number' || Date.now() - row.savedAt > MAX_AGE || typeof row.value?.name !== 'string') continue;
      const avatar = row.value.avatarUrl;
      cache[id] = { savedAt: row.savedAt, value: { name: row.value.name, email: typeof row.value.email === 'string' ? row.value.email : undefined, description: typeof row.value.description === 'string' ? row.value.description : undefined, avatarUrl: typeof avatar === 'string' && avatar.length < 50000 && avatar.startsWith('data:image/') ? paintableAvatarSrc(avatar) : null } };
    }
  } catch { /* Missing or corrupt cache is a cold start. */ }
}

export function cachedSessionStarter(identity: string | null): SessionStarter | null {
  const entry = identity ? cache[key(identity)] : null;
  return entry && Date.now() - entry.savedAt < MAX_AGE ? entry.value : null;
}

/** Decode once and retain a tiny local bitmap, rather than expiring presigned URLs. */
async function localAvatar(src: string | null): Promise<string | null> {
  if (!src || typeof Image === 'undefined') return src;
  return new Promise(resolve => {
    const image = new Image();
    const finish = (value: string | null) => { clearTimeout(timer); image.onload = null; image.onerror = null; resolve(value); };
    const timer = setTimeout(() => finish(src), 5000);
    image.crossOrigin = 'anonymous';
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 48;
        const context = canvas.getContext('2d');
        if (!context) return finish(src);
        context.drawImage(image, 0, 0, 48, 48);
        finish(canvas.toDataURL('image/png'));
      } catch { finish(src); }
    };
    image.onerror = () => finish(src);
    image.src = src;
  });
}

export function loadSessionStarter(identity: string): Promise<SessionStarter | null> {
  const id = key(identity);
  const entry = cache[id];
  if (entry && Date.now() - entry.savedAt < REFRESH_AFTER) return Promise.resolve(entry.value);
  const existing = pending.get(id);
  if (existing) return existing;
  const mine = epoch;
  const request = (async () => {
    const value = await fetchSessionStarter(identity);
    if (!value) return cachedSessionStarter(identity);
    value.avatarUrl = await localAvatar(value.avatarUrl);
    if (mine !== epoch) return null;
    if (account) {
      cache[id] = { value, savedAt: Date.now() };
      cache = Object.fromEntries(Object.entries(cache).sort((a, b) => b[1].savedAt - a[1].savedAt).slice(0, 40));
      try { localStorage.setItem(storageKey(), JSON.stringify(cache)); } catch { /* Memory cache still serves this app run. */ }
    }
    return value;
  })().finally(() => { if (mine === epoch) pending.delete(id); });
  pending.set(id, request);
  return request;
}
