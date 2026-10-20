// The signed-in person's uid for secondary windows (share-detail) that render
// the shared @hq/ui ReactionBar. The bar needs it to say "You" for the caller
// instead of naming them (see reactionsForBar in reactions.ts).
//
// Not cached across mounts: the share-detail window is reused across opens, and
// a cached uid could outlive a sign-out and sign-in as someone else. A failure
// resolves to null; callers then hide reactor names rather than show a wrong one.

import { invoke } from '@tauri-apps/api/core';

export async function loadSelfPersonUid(): Promise<string | null> {
  try {
    const identity = await invoke<{ personUid?: unknown } | null>('whoami');
    return typeof identity?.personUid === 'string' ? identity.personUid.trim() || null : null;
  } catch {
    return null;
  }
}
