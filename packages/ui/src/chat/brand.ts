/**
 * Tenant brand settings (extracted from desktop-alt lib/brand.ts — only the
 * record shape workspaces.ts references; the full brand engine is a later
 * wave).
 */

export interface CompanyBrandSettings {
  logoUrlLight?: string;
  logoUrlDark?: string;
  accentColor?: string;
  /** Owner-set company website. Optional on every plan. */
  website?: string;
  /**
   * Server-owned favicon resolved from `website`, as the durable API path.
   * NOT directly paintable under the packaged CSP — render the sibling
   * `iconUrl` (presigned, assets-host) instead. Kept here because it is part
   * of the settings record the console reads/writes.
   */
  faviconUrl?: string;
}
