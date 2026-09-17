/**
 * White-label brand runtime — now owned by `@hq/ui/brand` (PL-04), so the
 * menubar popover and the desktop shell share one implementation.
 *
 * This module stays as the app-local import path the popover and
 * `workspaces.ts` already use.
 */
export {
  BRAND_CACHE_KEY,
  isEntitledBrand,
  resolveBrandFromSources,
  selectLogoUrl,
  deriveAccentTokens,
  applyBrandToDocument,
  clearBrandFromDocument,
  readBrandCache,
  writeBrandCache,
  clearBrandCache,
  syncBrandFromWorkspaces,
  cacheLogoAssets,
  currentColorScheme,
  isSafeLogoUrl,
} from '@hq/ui/brand';
export type {
  BrandSource,
  CachedBrand,
  ColorScheme,
  CompanyBrandSettings,
  DerivedAccentTokens,
} from '@hq/ui/brand';
