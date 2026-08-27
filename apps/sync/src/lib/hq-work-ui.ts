/**
 * US-101 consume surface for hq-work-mono UI/platform packages.
 * US-102: Sync PlatformAdapter. US-103: DesktopApp mounts from desktop-alt.
 */
export type { PlatformAdapter } from '@hq/platform';
export {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
  type SyncPlatformAdapterConfig,
} from './hq-work-adapter';
export {
  bootDesktopAltWindow,
  resolveDesktopAltShell,
  type DesktopAltShell,
} from '../desktop-alt/boot';

/** Named export to import from this package: `import { DesktopApp } from '@hq/ui'`. */
export const HQ_WORK_UI_PACKAGE = '@hq/ui' as const;

/** Platform adapter types live on this package: `import type { PlatformAdapter } from '@hq/platform'`. */
export const HQ_WORK_PLATFORM_PACKAGE = '@hq/platform' as const;
