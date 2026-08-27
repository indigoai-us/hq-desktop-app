/**
 * US-101 consume surface for hq-work-mono UI/platform packages.
 * Mounting DesktopApp is US-103; the Sync PlatformAdapter is US-102.
 */
export type { PlatformAdapter } from '@hq/platform';
export {
  createSyncPlatformAdapter,
  type SyncInvokeFn,
  type SyncPlatformAdapterConfig,
} from './hq-work-adapter';

/** Named export to import from this package: `import { DesktopApp } from '@hq/ui'`. */
export const HQ_WORK_UI_PACKAGE = '@hq/ui' as const;

/** Platform adapter types live on this package: `import type { PlatformAdapter } from '@hq/platform'`. */
export const HQ_WORK_PLATFORM_PACKAGE = '@hq/platform' as const;
