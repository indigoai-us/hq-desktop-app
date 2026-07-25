import { describe, expect, it } from 'vitest';
import {
  V4_ROW_STACK_GAP_PX,
  V4_TYPE_SCALE,
} from '../../src/desktop-alt/v4/model';
import { readRepoFile } from './harness';

/**
 * DESKTOP-011 — Accessible responsive native behavior.
 *
 * Source contracts for: icon a11y, light/dark surface+text pairs, light
 * hierarchy, row title/meta grid gap, five-size type ramp, reduced motion /
 * transparency, list-detail collapse with primary actions, and safe titlebar
 * drag regions only.
 */

describe('DESKTOP-011: accessible responsive native behavior', () => {
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
  const secondary = readRepoFile('src/desktop-alt/v4/V4SecondarySidebar.svelte');
  const messages = readRepoFile('src/components/messaging/MessagesShell.svelte');
  const model = readRepoFile('src/desktop-alt/v4/model.ts');

  it('defines exactly five semantic type sizes and exports the ramp', () => {
    expect(V4_TYPE_SCALE).toEqual({
      metadata: 10,
      secondary: 11,
      body: 12,
      section: 14,
      detail: 18,
    });
    expect(model).toContain('V4_TYPE_SCALE');
    expect(tokens).toContain('--type-metadata: 10px');
    expect(tokens).toContain('--type-secondary: 11px');
    expect(tokens).toContain('--type-body: 12px');
    expect(tokens).toContain('--type-section: 14px');
    expect(tokens).toContain('--type-detail: 18px');
  });

  it('normalizes legacy --text-* aliases onto the five semantic sizes', () => {
    expect(desktopCss).toContain('--text-micro: var(--type-metadata, 10px)');
    expect(desktopCss).toContain('--text-xs: var(--type-secondary, 11px)');
    expect(desktopCss).toContain('--text-sm: var(--type-secondary, 11px)');
    expect(desktopCss).toContain('--text-base: var(--type-body, 12px)');
    expect(desktopCss).toContain('--text-section: var(--type-section, 14px)');
    expect(desktopCss).toContain('--text-lg: var(--type-detail, 18px)');
    expect(desktopCss).toContain('--text-kpi: var(--type-detail, 18px)');
    // Shared stylesheet mounts the token layer for desktop + messages.
    expect(desktopCss).toContain("@import '../v4/tokens.css'");
  });

  it('keeps light sidebar/chrome darker than canvas and raised lighter than canvas', () => {
    expect(tokens).toContain('--v4-ground: #f7f8fa');
    expect(tokens).toContain('--v4-chrome: rgba(222, 227, 233, 0.94)');
    expect(tokens).toContain('--v4-sidebar: rgba(222, 227, 233, 0.94)');
    expect(tokens).toContain('--v4-raised: #ffffff');
    expect(desktopCss).toContain('--surface-rail: var(--v4-sidebar');
    expect(desktopCss).toContain('--surface-panel: var(--v4-ground');
    expect(desktopCss).toContain('--surface-raise: var(--v4-raised');
  });

  it('pairs dark surfaces with light ink (never light-theme black text on dark)', () => {
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/,
    );
    expect(tokens).toMatch(/\.dark\s*\{[\s\S]*?--v4-text-1:\s*#f4f6f8/);
    // Light surfaces use dark ink.
    expect(tokens).toContain('--v4-text-1: #0a0c10');
    // Dark surface tokens exist alongside the light text.
    expect(tokens).toMatch(
      /@media \(prefers-color-scheme: dark\)\s*\{[\s\S]*?--v4-chrome:\s*rgba\(21, 25, 32/,
    );
  });

  it('uses an explicit 3px grid gap between primary row titles and secondary metadata', () => {
    expect(V4_ROW_STACK_GAP_PX).toBe(3);
    expect(tokens).toContain('--v4-row-stack-gap: 3px');
    expect(desktopCss).toMatch(
      /\.desktop-row-stack,\s*\.v4-row-stack\s*\{[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(sidebar).toMatch(
      /\.v4-footer\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(secondary).toMatch(
      /\.v4-context\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(secondary).toMatch(
      /\.v4-footer\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(messages).toMatch(
      /\.contact-meta\s*\{[\s\S]*?display:\s*grid;[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
    expect(messages).toMatch(
      /\.pane-title-stack\s*\{[\s\S]*?gap:\s*var\(--v4-row-stack-gap,\s*3px\)/,
    );
  });

  it('gives icon controls accessible labels and focus-visible states', () => {
    expect(titleBar).toContain('aria-label={sidebarCollapsed ? \'Show sidebar\' : \'Hide sidebar\'}');
    expect(titleBar).toContain('aria-label="Open command palette"');
    expect(titleBar).toContain('aria-label="Account and settings"');
    expect(titleBar).toMatch(/\.v4-icon-btn:focus-visible\s*\{/);
    expect(titleBar).toMatch(/\.v4-account:focus-visible\s*\{/);
    expect(desktopCss).toMatch(
      /\.desktop-icon-btn:focus-visible,\s*\.v4-icon-btn:focus-visible\s*\{/,
    );
    // Decorative SVGs inside icon buttons stay hidden from AT.
    expect(titleBar).toContain('aria-hidden="true"');
  });

  it('honors reduced motion and reduced transparency', () => {
    expect(desktopCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(desktopCss).toContain('animation-duration: 0.01ms !important');
    expect(desktopCss).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tokens).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(tokens).toContain('--v4-chrome: #dee3e9');
    expect(titleBar).toContain('@media (prefers-reduced-transparency: reduce)');
    expect(titleBar).toContain('@media (prefers-reduced-motion: reduce)');
    expect(messages).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('collapses wide list-detail while keeping primary actions unshrunk', () => {
    expect(desktopCss).toMatch(/\.list-detail\s*\{/);
    expect(desktopCss).toMatch(
      /\.list-detail\s+\.detail-primary-actions,[\s\S]*?flex:\s*0\s+0\s+auto/,
    );
    expect(desktopCss).toContain("@media (max-width: 820px)");
    expect(desktopCss).toContain(".list-detail[data-detail-open='true'] > .list-pane");
    // Messages: thread list-detail collapses to overlay on narrow widths.
    expect(messages).toContain('@media (max-width: 720px)');
    expect(messages).toMatch(/\.thread-column\s*\{[\s\S]*?position:\s*absolute/);
    expect(messages).toMatch(/\.rail-header\s+\.new-message-btn\s*\{[\s\S]*?flex:\s*0\s+0\s+auto/);
  });

  it('restricts titlebar drag to padded noninteractive spacers only', () => {
    expect(titleBar).not.toMatch(/<header class="v4-titlebar" data-tauri-drag-region/);
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-lights"');
    expect(titleBar).toContain('class="v4-drag-pad v4-drag-flex"');
    expect(titleBar).toContain('data-tauri-drag-region');
    expect(titleBar).toMatch(/\.v4-status\s*\{[\s\S]*?pointer-events:\s*none/);
    // Interactive controls must not be drag regions.
    expect(titleBar).not.toMatch(/class="v4-icon-btn"[^>]*data-tauri-drag-region/);
    expect(titleBar).not.toMatch(/class="v4-action"[^>]*data-tauri-drag-region/);
    expect(titleBar).not.toMatch(/class="v4-account"[^>]*data-tauri-drag-region/);
  });
});
