import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// US-010 originally wired a standalone company Activity panel. US-020 removed
// the Activity page entirely (Corey's feedback): activity lives on the company
// Overview digest, legacy activity deep-links remap to Overview, and the
// operations workspace under More is Deployments / Secrets / Settings only.
// This spec now guards the removal instead of the panel.

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);
const read = (...parts: string[]) => readFileSync(root(...parts), 'utf8');

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

describe('US-020: the standalone Activity page is gone', () => {
  it('has no ActivityPanel component and no activity operations destination', () => {
    expect(existsSync(root('src/desktop-alt/panels/ActivityPanel.svelte'))).toBe(false);

    const operations = normalize(read('src/desktop-alt/panels/CompanyOperationsPanel.svelte'));
    expect(operations).not.toContain('ActivityPanel');
    expect(operations).not.toContain("=== 'activity'");

    const route = normalize(read('src/desktop-alt/route.ts'));
    // 'activity' must not be a live company tab or operations destination…
    expect(route).toContain(
      "export type CompanyOperationsTab = 'deployments' | 'secrets' | 'settings'",
    );
    // …only a legacy redirect onto Overview.
    expect(route).toContain("activity: 'overview'");
  });

  it('remaps activity deep-links: notifications + widget land on the company Overview', () => {
    const feed = normalize(read('src/components/NotificationFeed.svelte'));
    expect(feed).not.toContain(':activity');
    expect(feed).toContain('route: `company:${company}`');

    const widget = normalize(read('src/components/Widget.svelte'));
    expect(widget).not.toContain(':activity');
  });

  it('keeps the Overview activity digest wired to get_company_activity', () => {
    // The DATA path survives — only the page surface was removed. The digest
    // on the company Overview still reads via the shared company store.
    const digest = normalize(read('src/desktop-alt/components/OverviewActivityDigest.svelte'));
    expect(digest).toContain('companyStore.loadActivity<Partial<CompanyActivity>>(slug)');

    const companyStore = normalize(read('src/desktop-alt/lib/company-store.svelte.ts'));
    expect(companyStore).toContain(
      "activity: (slug: string) => withActivityRequestDeadline(invoke<unknown>('get_company_activity', { slug }))",
    );
    const tauriMain = read('src-tauri/src/main.rs');
    expect(tauriMain).toContain('commands::desktop_alt::get_company_activity');
  });
});
