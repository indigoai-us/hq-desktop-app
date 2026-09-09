import { invoke } from '@tauri-apps/api/core';
import { createSyncPlatformAdapter } from '@hq/platform';
import { paintableAvatarSrc } from '../../../../../packages/ui/src/avatars/csp-image-src';
export interface SessionStarter { name: string; email?: string; description?: string; avatarUrl: string | null }
/** Resolve attribution without substituting the current viewer for another starter. */
export async function loadSessionStarter(identity: string): Promise<SessionStarter | null> {
  try {
    const adapter = createSyncPlatformAdapter({ invoke });
    const self = await adapter.identity.whoami();
    if (self.ok && [self.value.email, self.value.personUid].some(value => value?.toLowerCase() === identity.toLowerCase())) {
      const result = await adapter.identity.getProfile();
      const profile = result.ok ? result.value.profile : null;
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
