import { invoke } from '@tauri-apps/api/core';
import { setPageTitleFetcher } from '@hq/ui/link-titles';

/**
 * Route chat link page-title lookups to the Rust side. The webview never
 * fetches arbitrary sites; link_page_title does, without cookies or auth.
 */
export function installLinkTitleFetcher(): void {
  setPageTitleFetcher((url) => invoke<string | null>('link_page_title', { url }));
}
