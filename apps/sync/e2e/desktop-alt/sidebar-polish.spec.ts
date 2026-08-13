import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-005 — UI polish: balance item spacing + fixed-height company names with fade.
 *
 * Source-contract coverage for the two PRD e2eTests (sidebar render behavior).
 * Named sidebar-polish.spec.ts to avoid the unrelated pre-existing
 * __tests__/stories/US-005.test.ts (a DIFFERENT project's V4-Home story —
 * story-ID collision, not this PRD's US-005).
 *
 * US-018: V4Sidebar retired. Company-name fade + fixed row height now live on
 * FilesModeSidebar (mini company list). Conversation rows on ChatSidebar keep
 * fixed active-row styling. Shared spacing tokens still apply across chrome.
 *
 * Asserts the CSS contract that guarantees the rendered behavior:
 *  1. A very long company name keeps the row at the standard fixed row height
 *     (no growth) — single nowrap line, clipped with a right-edge mask fade
 *     instead of an ellipsis cutoff.
 *  2. The companies list scrolls on overflow while the tree below stays usable.
 *  3. Spacing is normalized to a shared token scale across sidebars and list rows.
 */

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
const filesSidebar = readRepoFile('src/desktop-alt/v4/FilesModeSidebar.svelte');
const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
const desktopAltCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');

describe('US-005: balanced spacing + fixed-height company names with fade', () => {
  it('declares a shared spacing scale in the V4 tokens (documented values)', () => {
    // 4px-based scale + canonical row height + inter-row gap, declared once.
    expect(tokens).toContain('--v4-space-1: 4px');
    expect(tokens).toContain('--v4-space-2: 8px');
    expect(tokens).toContain('--v4-space-3: 12px');
    expect(tokens).toContain('--v4-space-4: 16px');
    expect(tokens).toContain('--v4-space-5: 20px');
    expect(tokens).toContain('--v4-space-6: 24px');
    expect(tokens).toContain('--v4-row-h: 28px');
    expect(tokens).toContain('--v4-row-gap: 2px');
  });

  it('e2e-1: a long company name cannot grow the row — fixed height, nowrap, fade not ellipsis', () => {
    const css = normalize(filesSidebar);

    // Files mode company row height resolves from the shared token.
    expect(css).toMatch(/\.fs-company-row\s*\{[^}]*height:\s*var\(--v4-row-h\)/);

    // The name span is a single fixed line that never wraps/grows.
    expect(css).toMatch(/\.fs-company-name\s*\{[^}]*white-space:\s*nowrap/);
    expect(css).toMatch(/\.fs-company-name\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.fs-company-name\s*\{[^}]*min-width:\s*0/);

    // Clipped with a right-edge mask fade (both standard + WebKit prefix),
    // NOT a hard ellipsis cutoff.
    expect(css).toMatch(
      /\.fs-company-name\s*\{[^}]*-webkit-mask-image:\s*linear-gradient\(to right,/,
    );
    expect(css).toMatch(
      /\.fs-company-name\s*\{[^}]*[^-]mask-image:\s*linear-gradient\(to right,/,
    );
    expect(css).not.toMatch(/\.fs-company-name\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('e2e-1: the status dot stays fixed-size so name length never shifts alignment', () => {
    const css = normalize(filesSidebar);
    // Dot is non-shrinking; name takes the remaining width.
    expect(css).toMatch(/\.fs-dot\s*\{[^}]*flex:\s*0 0 6px/);
    expect(css).toMatch(/\.fs-company-name\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it('e2e-2: the companies list scrolls on overflow while the rest of the sidebar stays usable', () => {
    const css = normalize(filesSidebar);

    // Companies list scrolls and can grow within its region.
    expect(css).toMatch(/\.fs-company-list\s*\{[^}]*flex:\s*1 1 auto/);
    expect(css).toMatch(/\.fs-company-list\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.fs-company-list\s*\{[^}]*min-height:\s*0/);

    // Thin-scrollbar styling preserved.
    expect(css).toMatch(/\.fs-company-list\s*\{[^}]*scrollbar-width:\s*thin/);
    expect(css).toContain('.fs-company-list::-webkit-scrollbar');
    expect(css).toContain('.fs-company-list::-webkit-scrollbar-thumb');
  });

  it('keeps active rows visible as an open neutral baseline', () => {
    const filesCss = normalize(filesSidebar);
    expect(filesCss).toMatch(
      /\.fs-company-row\.active\s*\{[^}]*background:\s*transparent;[^}]*box-shadow:\s*inset 0 -1px 0 var\(--v4-hairline\)/,
    );

    // Daybook parity override (prd.json decisions): chat active rows use
    // Lizzie Liu's neutral --sel fill instead of the transparent baseline.
    const chatCss = normalize(chatSidebar);
    expect(chatCss).toMatch(
      /\.chat-row\.active\s*\{[^}]*background:\s*var\(--sel\);[^}]*box-shadow:\s*none/,
    );
  });

  it('applies the shared row-height + gap tokens across list rows (US-020 retired the secondary sidebar)', () => {
    // Files company list uses the same gap token.
    expect(normalize(filesSidebar)).toMatch(
      /\.fs-company-list\s*\{[^}]*gap:\s*var\(--v4-row-gap\)/,
    );

    // desktop-alt list rows resolve from the same row-height token.
    expect(normalize(desktopAltCss)).toMatch(/\.empty-row\s*\{[^}]*height:\s*var\(--v4-row-h/);
  });
});
