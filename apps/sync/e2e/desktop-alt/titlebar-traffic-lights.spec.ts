import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * Source-contract: the overlay traffic lights share one centre-line with the
 * titlebar content (sidebar toggle, HQ wordmark, DAY · DATE).
 *
 * The live desktop window mounts `@hq/ui` V4TitleBar. Native macOS lights are
 * positioned via Tauri `trafficLightPosition` / `traffic_light_position`,
 * using the same titlebar height as the CSS. If the titlebar height changes,
 * `trafficLightYPx(height)` / `traffic_light_y_px` follow it — do not invent
 * a second offset.
 */

const tsLayout = readFileSync(
  fileURLToPath(
    new URL('../../../../packages/ui/src/home/titlebar-layout.ts', import.meta.url),
  ),
  'utf8',
);
const rustLayout = readFileSync(
  fileURLToPath(new URL('../../src-tauri/src/titlebar_layout.rs', import.meta.url)),
  'utf8',
);
const conf = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../src-tauri/tauri.conf.json', import.meta.url)),
    'utf8',
  ),
);

function tsNumberConst(name: string): number {
  const match = tsLayout.match(new RegExp(`export const ${name} = ([0-9.]+)`));
  expect(match, `TS const ${name}`).not.toBeNull();
  return Number(match?.[1]);
}

function rustF64Const(name: string): number {
  const match = rustLayout.match(new RegExp(`const ${name}: f64 = ([0-9.]+)`));
  expect(match, `Rust const ${name}`).not.toBeNull();
  return Number(match?.[1]);
}

describe('desktop-alt overlay traffic lights share the titlebar centre line', () => {
  const titleBar = readRepoFile('../../packages/ui/src/home/V4TitleBar.svelte');
  const builder = readRepoFile('src-tauri/src/commands/desktop_alt.rs');
  const desktopAlt = (conf.app?.windows ?? []).find(
    (w: { label?: string }) => w.label === 'desktop-alt',
  );

  const titleBarHeight = tsNumberConst('TITLEBAR_HEIGHT_PX');
  const gutter = tsNumberConst('TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX');
  const trafficX = tsNumberConst('TITLEBAR_TRAFFIC_LIGHT_X_PX');
  const buttonHeight = tsNumberConst('MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX');
  const trafficY = titleBarHeight / 2;

  it('keeps one titlebar height across CSS, TS, and Rust', () => {
    const tokens = readRepoFile('../../packages/ui/src/home/tokens.css');
    expect(titleBarHeight).toBe(48);
    expect(rustF64Const('TITLEBAR_HEIGHT_PX')).toBe(titleBarHeight);
    expect(tokens).toContain('--titlebar-height: 48px');
    expect(titleBar).toContain('--titlebar-height');
    expect(titleBar).toMatch(/flex:\s*0 0 var\(--titlebar-height/);
    expect(titleBar).toMatch(/height:\s*var\(--titlebar-height/);
    expect(titleBar).not.toMatch(/flex:\s*0 0 48px/);
    expect(titleBar).not.toMatch(/height:\s*48px/);
  });

  it('keeps the macOS traffic-light gutter as the same shared constant', () => {
    const tokens = readRepoFile('../../packages/ui/src/home/tokens.css');
    expect(gutter).toBe(78);
    expect(rustF64Const('TITLEBAR_TRAFFIC_LIGHT_GUTTER_PX')).toBe(gutter);
    expect(tokens).toMatch(
      /\.has-window-controls\s*\{[\s\S]*--titlebar-leading-inset:\s*78px/,
    );
    expect(titleBar).toContain('--titlebar-leading-inset');
    expect(titleBar).toContain('has-window-controls');
    expect(titleBar).toMatch(/padding-left:\s*var\(--titlebar-leading-inset\)/);
    expect(titleBar).not.toMatch(/padding-left:\s*78px/);
  });

  it('computes trafficLightPosition.y as the titlebar content centre', () => {
    expect(trafficY).toBe(24);
    expect(trafficX).toBe(20);
    expect(buttonHeight).toBe(14);
    expect(rustF64Const('TITLEBAR_TRAFFIC_LIGHT_X_PX')).toBe(trafficX);
    expect(rustF64Const('MACOS_TRAFFIC_LIGHT_BUTTON_HEIGHT_PX')).toBe(buttonHeight);
    expect(tsLayout).toContain('titleBarHeightPx / 2');
    expect(rustLayout).toContain('fn traffic_light_y_px');
    expect(rustLayout).toContain('titlebar_height / 2.0');
  });

  it('declares the same offset on the lazily built window and in tauri.conf.json', () => {
    expect(desktopAlt.decorations).toBe(true);
    expect(desktopAlt.titleBarStyle).toBe('Overlay');
    expect(desktopAlt.hiddenTitle).toBe(true);
    expect(desktopAlt.trafficLightPosition).toEqual({
      x: trafficX,
      y: trafficY,
    });

    expect(builder).toContain('.hidden_title(true)');
    expect(builder).toContain('.traffic_light_position(tauri::LogicalPosition::new');
    expect(builder).toContain('crate::titlebar_layout::traffic_light_position');
    expect(builder).toContain('crate::titlebar_layout::TITLEBAR_HEIGHT_PX');
  });

  it('does not draw fake CSS traffic-light dots', () => {
    expect(titleBar).not.toContain('titlebar-traffic');
    expect(titleBar).not.toContain('#ff5f57');
  });
});
