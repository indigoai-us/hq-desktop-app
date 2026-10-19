import { invoke } from '@tauri-apps/api/core';
import { setPageTitleFetcher } from '@hq/ui/link-titles';
import { setGithubSummaryFetcher, type GithubLinkSummary } from '@hq/ui/link-github';

/**
 * Route chat link page-title lookups to the Rust side. The webview never
 * fetches arbitrary sites; link_page_title does, without cookies or auth.
 * GitHub PR and issue links get live details from link_github_summary.
 */
export function installLinkTitleFetcher(): void {
  setPageTitleFetcher((url) => invoke<string | null>('link_page_title', { url }));
  setGithubSummaryFetcher((url) => invoke<GithubLinkSummary | null>('link_github_summary', { url }));
}
