// @vitest-environment happy-dom
//
// US-002: Floating widget window (wordmark, translucent, appearance-reactive)
// Real component mounts of Widget (no Tauri deps) + source-contract on the
// Rust window setup, main.ts router, capability, and CSS appearance/opacity.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Vitest resolves Svelte's public entry with the default/server condition in
// this repo's node test config, even for per-file happy-dom tests. Force the
// client entry so mount/flushSync work (same pattern as onboarding-setup.test.ts).
vi.mock('svelte', async () => {
  // @ts-expect-error client entry has no public type export.
  return await import('../../node_modules/svelte/src/index-client.js');
});

import { flushSync, mount, unmount } from 'svelte';
import Widget from '../../src/components/Widget.svelte';

const root = (...parts: string[]) => resolve(process.cwd(), ...parts);

const widgetSource = readFileSync(root('src/components/Widget.svelte'), 'utf8');
const widgetRs = readFileSync(root('src-tauri/src/commands/widget.rs'), 'utf8');
const mainRs = readFileSync(root('src-tauri/src/main.rs'), 'utf8');
const mainTs = readFileSync(root('src/main.ts'), 'utf8');
const widgetCapPath = root('src-tauri/capabilities/widget.json');
const widgetCap = JSON.parse(readFileSync(widgetCapPath, 'utf8')) as {
  windows?: string[];
};

let host: HTMLElement;
let component: ReturnType<typeof mount> | null = null;

function mountWidget(props: Record<string, unknown> = {}): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  component = mount(Widget, { target: host, props });
  flushSync();
  return host;
}

afterEach(async () => {
  if (component) {
    await unmount(component);
    component = null;
  }
  host?.remove();
  vi.clearAllMocks();
});

describe('US-002: Floating widget window (wordmark, translucent, appearance-reactive)', () => {
  it('Given the widget is enabled, when the app launches, then a wordmark-only window appears at the lower-right of the configured display', () => {
    // Real mount: wordmark-only chrome — one HQ svg, no queued superscript at 0
    mountWidget({ queued: 0 });

    const marks = host.querySelectorAll('svg[role="img"][aria-label="HQ"]');
    expect(marks.length).toBe(1);
    expect(host.querySelector('.qd')).toBeNull();

    // No circular/badge container around the mark (source contract on CSS)
    // .wm / .wg must not use border-radius; .wm has no background behind the mark
    const wmBlock = widgetSource.match(/\.wm\s*\{[^}]+\}/s)?.[0] ?? '';
    const wgBlock = widgetSource.match(/\.wg\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(wmBlock).not.toMatch(/border-radius/);
    expect(wgBlock).not.toMatch(/border-radius/);
    expect(wmBlock).not.toMatch(/background\s*:/);
    // .qd style block: plain superscript — no background, border, or border-radius
    const qdBlock = widgetSource.match(/\.qd\s*\{[^}]+\}/s)?.[0] ?? '';
    expect(qdBlock).toBeTruthy();
    expect(qdBlock).not.toMatch(/background\s*:/);
    expect(qdBlock).not.toMatch(/border\s*:/);
    expect(qdBlock).not.toMatch(/border-radius/);

    // Rust window setup (label + flags + lower-right anchor)
    expect(widgetRs).toMatch(/WINDOW_LABEL:\s*&str\s*=\s*"widget"/);
    expect(widgetRs).toContain('.always_on_top(true)');
    expect(widgetRs).toContain('.transparent(true)');
    expect(widgetRs).toContain('.decorations(false)');
    expect(widgetRs).toContain('.skip_taskbar(true)');
    expect(widgetRs).toContain('.focusable(false)');
    expect(widgetRs).toContain('.visible_on_all_workspaces(true)');
    expect(widgetRs).toContain('MARGIN_RIGHT');
    expect(widgetRs).toContain('MARGIN_BOTTOM');
    expect(widgetRs).toContain('visibleFrame');

    // main.rs wires setup at launch; main.ts routes the label; capability exists
    expect(mainRs).toContain('setup_widget_window');
    expect(mainTs).toMatch(/windowLabel\s*===\s*['"]widget['"]/);
    expect(mainTs).toMatch(/import Widget from ['"]\.\/components\/Widget\.svelte['"]/);
    expect(existsSync(widgetCapPath)).toBe(true);
    expect(widgetCap.windows).toEqual(['widget']);
  });

  it('Given the widget is idle, when rendered, then opacity is reduced; when hovered, then full opacity', () => {
    // CSS contract: idle translucency + hover full opacity with transition
    expect(widgetSource).toMatch(/\.wm\s*\{[^}]*opacity:\s*0\.38/s);
    expect(widgetSource).toMatch(/\.wm\s*\{[^}]*transition:\s*opacity/s);
    expect(widgetSource).toMatch(/\.wg:hover\s+\.wm\s*\{[^}]*opacity:\s*1/s);
  });

  it('Given macOS switches between light and dark appearance, when the system appearance changes, then the wordmark color updates without restart', () => {
    // prefers-color-scheme drives --wm-fg (no screen-recording APIs)
    expect(widgetSource).toMatch(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/);
    expect(widgetSource).toMatch(/--wm-fg:\s*#1d1d1f/);
    expect(widgetSource).toMatch(
      /@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)[\s\S]*?--wm-fg:\s*#fff/,
    );

    // No ScreenCaptureKit / CGWindowList / CGDisplayStream *usage* (would need
    // screen-recording permission). Mentions in design-lock docs are fine —
    // strip comments before asserting executable source is free of those APIs.
    const widgetRsCode = widgetRs
      .replace(/\/\/!.*$/gm, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(widgetRsCode).not.toMatch(/ScreenCaptureKit/i);
    expect(widgetRsCode).not.toMatch(/CGWindowList/);
    expect(widgetRsCode).not.toMatch(/CGDisplayStream/);
  });

  it('Given queued > 0, when the widget renders, then a plain superscript numeral is shown', () => {
    mountWidget({ queued: 3 });

    const qd = host.querySelector('.qd');
    expect(qd).toBeTruthy();
    expect(qd?.textContent).toBe('3');
  });
});
