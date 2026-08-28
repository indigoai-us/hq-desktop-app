/**
 * Tenant brand settings (extracted from desktop-alt lib/brand.ts — only the
 * record shape workspaces.ts references; the full brand engine is a later
 * wave).
 */

export interface CompanyBrandSettings {
  logoUrlLight?: string;
  logoUrlDark?: string;
  accentColor?: string;
}
