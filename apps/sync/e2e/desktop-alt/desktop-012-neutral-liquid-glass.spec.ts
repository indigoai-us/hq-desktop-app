import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(?:css|svelte)$/.test(entry) ? [path] : [];
  });
}

function declaredColorChannels(source: string, property: string): number[][] {
  const declarations = [
    ...source.matchAll(new RegExp(`--${property}:\\s*([^;]+);`, 'g')),
  ].flatMap((match) => [
    ...match[1].matchAll(
      /#([0-9a-f]{6})\b|rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi,
    ),
  ]);

  return declarations.map((match) => {
    if (match[1]) {
      return [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16),
      ];
    }
    return [Number(match[2]), Number(match[3]), Number(match[4])];
  });
}

function balancedBlock(source: string, marker: string): string {
  const markerIndex = source.indexOf(marker);
  expect(markerIndex, `missing CSS block marker: ${marker}`).toBeGreaterThanOrEqual(0);
  const openIndex = source.indexOf('{', markerIndex);
  expect(openIndex, `missing opening brace after: ${marker}`).toBeGreaterThanOrEqual(0);

  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openIndex + 1, index);
  }

  throw new Error(`unclosed CSS block after: ${marker}`);
}

function lastBalancedBlock(source: string, marker: string): string {
  const markerIndex = source.lastIndexOf(marker);
  expect(
    markerIndex,
    `missing final CSS block marker: ${marker}`,
  ).toBeGreaterThanOrEqual(0);
  return balancedBlock(source.slice(markerIndex), marker);
}

function customProperty(block: string, property: string): string {
  const match = block.match(new RegExp(`--${property}:\\s*([^;]+);`));
  expect(match, `missing --${property}`).not.toBeNull();
  return match?.[1].trim() ?? '';
}

const DEFAULT_WINDOW_TRANSPARENCY_FACTOR = 0.65;

function liquidGlassAlpha(
  value: string,
  factor = DEFAULT_WINDOW_TRANSPARENCY_FACTOR,
): number {
  const expression = value.match(
    /^rgb\(\s*\d+\s+\d+\s+\d+\s*\/\s*clamp\(\s*([\d.]+)\s*,\s*calc\(\s*1\s*-\s*var\(--hq-window-transparency-factor(?:\s*,\s*([\d.]+))?\)\s*\*\s*([\d.]+)\s*\)\s*,\s*([\d.]+)\s*\)\s*\)$/i,
  );
  expect(
    expression,
    `expected a window-transparency liquid-glass material, received: ${value}`,
  ).not.toBeNull();

  const floor = Number(expression?.[1]);
  const fallback = expression?.[2];
  const multiplier = Number(expression?.[3]);
  const ceiling = Number(expression?.[4]);
  if (fallback !== undefined) {
    expect(Number(fallback), 'material must retain the 0.65 default factor').toBe(
      DEFAULT_WINDOW_TRANSPARENCY_FACTOR,
    );
  }
  expect(ceiling, 'material must resolve fully opaque at factor 0').toBe(1);
  return Math.min(ceiling, Math.max(floor, 1 - factor * multiplier));
}

function saturationPercent(value: string): number {
  const match = value.match(/saturate\(\s*([\d.]+)(%)?\s*\)/i);
  expect(match, `expected a saturation component, received: ${value}`).not.toBeNull();
  const amount = Number(match?.[1]);
  return match?.[2] ? amount : amount * 100;
}

function blurPixels(value: string): number {
  const match = value.match(/blur\(\s*([\d.]+)px\s*\)/i);
  expect(match, `expected a pixel blur component, received: ${value}`).not.toBeNull();
  return Number(match?.[1]);
}

function expectSolidSurface(block: string, property: string): void {
  const value = customProperty(block, property);
  expect(value, `${property} must be a solid reduced-transparency fallback`).toMatch(
    /^#[0-9a-f]{3,8}$/i,
  );
}

describe('DESKTOP-012: neutral liquid-glass materials', () => {
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const designSystem = readRepoFile('src/styles/design-system.css');
  const popover = readRepoFile('src/styles/popover.css');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  // US-018: ChatSidebar is the primary sidebar chrome (V4Sidebar retired).
  const sidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
  const secondarySidebar = readRepoFile('src/desktop-alt/v4/V4SecondarySidebar.svelte');
  const filesSidebar = readRepoFile('src/desktop-alt/v4/FilesModeSidebar.svelte');
  const commandPalette = readRepoFile('src/desktop-alt/components/CommandPalette.svelte');
  const versionPopout = readRepoFile('src/desktop-alt/components/VersionPopout.svelte');
  const desktopCss = readRepoFile('src/desktop-alt/styles/desktop-alt.css');
  const desktopApp = readRepoFile('src/desktop-alt/DesktopApp.svelte');
  const storyDetail = readRepoFile('src/desktop-alt/components/StoryDetailPanel.svelte');
  const widgetSettings = readRepoFile('src/components/WidgetSettings.svelte');
  const widget = readRepoFile('src/components/Widget.svelte');
  const onboarding = readRepoFile('src/components/onboarding/OnboardingWizard.svelte');
  const globalError = readRepoFile('src/components/GlobalErrorBoundary.svelte');
  const popoverWindow = readRepoFile('src/components/Popover.svelte');
  const bannerNotification = readRepoFile('src/components/BannerNotification.svelte');
  const driftDetail = readRepoFile('src/components/DriftDetail.svelte');
  const meetingsWindow = readRepoFile('src/components/MeetingsWindow.svelte');
  const moderationPanel = readRepoFile('src/desktop-alt/panels/ModerationPanel.svelte');
  const harness = readRepoFile('dev-harness/Harness.svelte');

  it('uses achromatic light and dark surface, ink, accent, and shadow tokens', () => {
    expect(tokens).toContain('--v4-unread: var(--v4-text-1)');
    expect(tokens).toContain('--v4-shadow-popover:');

    for (const property of [
      'v4-ground',
      'v4-raised',
      'v4-inset',
      'v4-chrome',
      'v4-sidebar',
      'v4-secondary-sidebar',
      'v4-popover',
      'v4-hairline',
      'v4-rowline',
      'v4-text-1',
      'v4-text-2',
      'v4-text-3',
      'v4-idle',
      'v4-shadow-popover',
      'v4-shadow-window',
    ]) {
      const colors = declaredColorChannels(tokens, property);
      expect(colors.length, `${property} should declare concrete neutral fallbacks`).toBeGreaterThan(
        0,
      );
      for (const [red, green, blue] of colors) {
        expect([red, green, blue], `${property} contains a tinted color`).toEqual([
          red,
          red,
          red,
        ]);
      }
    }

    const knownCoolTintLiterals = [
      '#f7f8fa',
      '#eef1f4',
      '#dee3e9',
      '#0c1016',
      '#191e27',
      '#0e1218',
      '#151920',
      '#181e27',
      '#0a6fd6',
      '#60a5fa',
      'rgba(20, 22, 40',
      'rgba(25, 33, 44',
      'rgba(21, 25, 32',
      'rgba(24, 30, 39',
    ];
    for (const tint of knownCoolTintLiterals) {
      expect(tokens.toLowerCase(), `tokens.css still contains ${tint}`).not.toContain(tint);
    }
  });

  it('keeps broad light and dark materials visibly translucent with weighted hierarchy', () => {
    const light = balancedBlock(tokens, ":root,\n:root[data-force-theme='light']");
    const dark = balancedBlock(tokens, ".dark,\n:root[data-force-theme='dark']");
    const lightCeilings = {
      'v4-ground': 0.5,
      'v4-chrome': 0.5,
      'v4-sidebar': 0.5,
      'v4-secondary-sidebar': 0.5,
      'v4-raised': 0.6,
      'v4-popover': 0.88,
    } as const;
    const darkCeilings = {
      'v4-ground': 0.72,
      'v4-chrome': 0.72,
      'v4-sidebar': 0.74,
      'v4-secondary-sidebar': 0.66,
      'v4-raised': 0.78,
      'v4-popover': 0.98,
    } as const;

    for (const [mode, block, ceilings] of [
      ['light', light, lightCeilings],
      ['dark', dark, darkCeilings],
    ] as const) {
      const alphas = Object.fromEntries(
        Object.entries(ceilings).map(([property, ceiling]) => {
          const material = customProperty(block, property);
          const alpha = liquidGlassAlpha(material);
          expect(alpha, `${mode} ${property} must remain visibly translucent`).toBeGreaterThan(
            0.2,
          );
          expect(alpha, `${mode} ${property} exceeds its material alpha ceiling`).toBeLessThanOrEqual(
            ceiling,
          );
          expect(
            liquidGlassAlpha(material, 0),
            `${mode} ${property} must become opaque when window transparency is disabled`,
          ).toBe(1);
          return [property, alpha];
        }),
      );

      expect(alphas['v4-raised']).toBeGreaterThan(alphas['v4-ground']);
      expect(alphas['v4-popover']).toBeGreaterThanOrEqual(alphas['v4-raised']);
    }
  });

  it('lets the unsupported-filter fallback become literally solid at 100% opacity', () => {
    const fallback = tokens.slice(
      tokens.indexOf('@supports not ((backdrop-filter: blur(1px))'),
    );
    expect(fallback).toContain(
      '--v4-fallback-material-alpha: clamp(0.92, calc(1 - var(--hq-window-transparency-factor, 0.65) * 0.03), 1)',
    );
    expect(fallback).toContain(
      '--v4-ground: rgb(242 242 242 / var(--v4-fallback-material-alpha))',
    );
    expect(fallback).not.toMatch(/rgba\([^)]*,\s*0\.98\)/);
  });

  it('defines one restrained live-vibrancy filter stack and routes desktop chrome through it', () => {
    const primitives = balancedBlock(tokens, ':root {');
    const canvasFilter = customProperty(primitives, 'v4-canvas-filter');
    const standardFilter = customProperty(primitives, 'v4-glass-filter');
    const softFilter = customProperty(primitives, 'v4-glass-filter-soft');
    const popoverFilter = customProperty(primitives, 'v4-glass-filter-popover');
    const canvasSaturation = saturationPercent(canvasFilter);
    const standardSaturation = saturationPercent(standardFilter);
    const softSaturation = saturationPercent(softFilter);
    const popoverSaturation = saturationPercent(popoverFilter);

    expect(canvasSaturation).toBeGreaterThanOrEqual(108);
    expect(canvasSaturation).toBeLessThanOrEqual(135);
    expect(standardSaturation).toBeGreaterThanOrEqual(108);
    expect(standardSaturation).toBeLessThanOrEqual(135);
    expect(softSaturation).toBeGreaterThanOrEqual(108);
    expect(softSaturation).toBeLessThanOrEqual(135);
    expect(popoverSaturation).toBeGreaterThanOrEqual(108);
    expect(popoverSaturation).toBeLessThanOrEqual(135);
    expect(canvasSaturation).toBeGreaterThanOrEqual(softSaturation);
    expect(standardSaturation).toBeGreaterThanOrEqual(softSaturation);
    expect(popoverSaturation).toBeGreaterThanOrEqual(standardSaturation);
    expect(blurPixels(canvasFilter)).toBeGreaterThanOrEqual(12);
    expect(blurPixels(canvasFilter)).toBeLessThanOrEqual(28);
    expect(blurPixels(standardFilter)).toBeGreaterThanOrEqual(24);
    expect(blurPixels(standardFilter)).toBeLessThanOrEqual(40);
    expect(blurPixels(softFilter)).toBeGreaterThanOrEqual(8);
    expect(blurPixels(softFilter)).toBeLessThanOrEqual(24);
    expect(blurPixels(popoverFilter)).toBeGreaterThanOrEqual(32);
    expect(blurPixels(popoverFilter)).toBeLessThanOrEqual(48);
    expect(blurPixels(standardFilter)).toBeGreaterThan(blurPixels(softFilter));
    expect(blurPixels(popoverFilter)).toBeGreaterThan(blurPixels(standardFilter));
    expect(tokens).toContain('--v4-glass-highlight: rgba(255, 255, 255, 0.58)');
    expect(tokens).toContain('--v4-glass-border: var(--v4-hairline)');

    for (const [name, source] of [
      ['title bar', titleBar],
      ['primary sidebar', sidebar],
      ['secondary sidebar', secondarySidebar],
      ['files sidebar', filesSidebar],
      ['command palette', commandPalette],
      ['version updater', versionPopout],
    ] as const) {
      expect(source, `${name} bypasses the shared glass material`).toContain(
        'var(--v4-glass-filter',
      );
    }
  });

  it('aliases legacy desktop surfaces onto the material stack instead of opaque shared defaults', () => {
    const desktopScope = balancedBlock(
      desktopCss,
      "html[data-window='desktop-alt'],\nhtml[data-window='messages'] {",
    );
    const aliases = {
      'page-bg': 'var(--v4-ground)',
      'c-bg': 'var(--v4-raised)',
      'pop-bg': 'var(--v4-popover)',
      'glass-filter': 'var(--v4-glass-filter)',
      'glass-filter-soft': 'var(--v4-glass-filter-soft)',
    } as const;

    for (const [legacy, material] of Object.entries(aliases)) {
      expect(customProperty(desktopScope, legacy)).toBe(material);
    }

    // Forced themes power the browser visual harness and must resolve through
    // the same translucent stack rather than replacing it with opaque literals.
    expect(tokens.match(/--page-bg:\s*var\(--v4-ground\);/g)).toHaveLength(2);
    expect(tokens.match(/--c-bg:\s*var\(--v4-raised\);/g)).toHaveLength(2);
    expect(tokens.match(/--pop-bg:\s*var\(--v4-popover\);/g)).toHaveLength(2);
  });

  it('provides complete solid light and dark fallbacks when transparency is reduced', () => {
    const reduced = balancedBlock(tokens, '@media (prefers-reduced-transparency: reduce)');
    const light = balancedBlock(reduced, ":root,\n  :root[data-force-theme='light']");
    const systemDarkMedia = balancedBlock(reduced, '@media (prefers-color-scheme: dark)');
    const systemDark = balancedBlock(systemDarkMedia, ':root');
    const forcedDark = balancedBlock(reduced, ".dark,\n  :root[data-force-theme='dark']");
    const surfaces = [
      'v4-ground',
      'v4-raised',
      'v4-inset',
      'v4-chrome',
      'v4-sidebar',
      'v4-secondary-sidebar',
      'v4-popover',
    ];

    for (const property of surfaces) {
      expectSolidSurface(light, property);
      expectSolidSurface(systemDark, property);
      expectSolidSurface(forcedDark, property);
    }
    expect(customProperty(light, 'v4-glass-filter')).toBe('none');
    expect(customProperty(light, 'v4-glass-filter-soft')).toBe('none');
    expect(customProperty(light, 'v4-canvas-filter')).toBe('none');
    expect(customProperty(light, 'v4-glass-filter-popover')).toBe('none');

    const desktopReduced = balancedBlock(
      desktopCss,
      '@media (prefers-reduced-transparency: reduce)',
    );
    expect(desktopReduced).toMatch(
      /html\[data-window='desktop-alt'\]\s*\{[\s\S]*?background:\s*var\(--bg\);/,
    );
    expect(desktopReduced).toMatch(
      /html\[data-window='desktop-alt'\]\s+body\s*\{[\s\S]*?background:\s*var\(--bg-body\);/,
    );
  });

  it('keeps forced light and dark shared materials solid when transparency is reduced', () => {
    const designReduced = lastBalancedBlock(
      designSystem,
      '@media (prefers-reduced-transparency: reduce)',
    );
    const designLight = balancedBlock(
      designReduced,
      ":root[data-force-theme='light']",
    );
    const designDark = balancedBlock(
      designReduced,
      ":root[data-force-theme='dark']",
    );

    for (const block of [designLight, designDark]) {
      expectSolidSurface(block, 'pop-bg');
      expectSolidSurface(block, 'compact-glass-bg');
      expectSolidSurface(block, 'compact-glass-rail');
      expectSolidSurface(block, 'compact-glass-selected');
      expect(customProperty(block, 'glass-filter')).toBe('none');
      expect(customProperty(block, 'glass-filter-soft')).toBe('none');
    }

    const popoverReduced = lastBalancedBlock(
      popover,
      '@media (prefers-reduced-transparency: reduce)',
    );
    const popoverLight = balancedBlock(
      popoverReduced,
      ":root[data-force-theme='light']",
    );
    const popoverDark = balancedBlock(
      popoverReduced,
      ":root[data-force-theme='dark']",
    );

    for (const block of [popoverLight, popoverDark]) {
      expectSolidSurface(block, 'pop-bg');
      expectSolidSurface(block, 'menu-bg');
      expect(customProperty(block, 'popover-bg')).toBe('var(--pop-bg)');
      expect(customProperty(block, 'popover-blur')).toBe('none');
    }
  });

  it('does not double-compose the translucent canvas beneath glass chrome', () => {
    const shellRule = desktopCss.match(/\.desktop-shell\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const canvasRule =
      [...desktopCss.matchAll(/\.desktop-main\s*\{([\s\S]*?)\}/g)]
        .map((match) => match[1])
        .find((block) => block.includes('background:')) ?? '';
    expect(shellRule).toContain('background: transparent');
    expect(desktopApp).not.toMatch(
      /\.desktop-shell\s*\{[\s\S]*?background:\s*var\(--v4-ground\)[\s\S]*?\}/,
    );
    expect(canvasRule).not.toContain('backdrop-filter:');
    expect(canvasRule).not.toContain('-webkit-backdrop-filter:');
  });

  it('keeps the shared popover system within the same neutral live-vibrancy bounds', () => {
    const sharedPrimitives = balancedBlock(designSystem, ':root {');
    const sharedFilter = customProperty(sharedPrimitives, 'glass-filter');
    const sharedSoftFilter = customProperty(sharedPrimitives, 'glass-filter-soft');
    const sharedPopover = customProperty(sharedPrimitives, 'pop-bg');

    expect(designSystem).toContain('--page-bg:#eeeeee');
    expect(customProperty(sharedPrimitives, 'hq-window-transparency-factor')).toBe('0.65');
    expect(sharedPopover).toMatch(/^rgb\(\s*250\s+250\s+250\s*\//);
    expect(liquidGlassAlpha(sharedPopover)).toBeCloseTo(0.58, 2);
    expect(liquidGlassAlpha(sharedPopover, 0)).toBe(1);
    expect(saturationPercent(sharedFilter)).toBeGreaterThanOrEqual(118);
    expect(saturationPercent(sharedFilter)).toBeLessThanOrEqual(135);
    expect(saturationPercent(sharedSoftFilter)).toBeGreaterThanOrEqual(110);
    expect(saturationPercent(sharedSoftFilter)).toBeLessThanOrEqual(125);
    expect(blurPixels(sharedFilter)).toBeGreaterThan(blurPixels(sharedSoftFilter));
    expect(designSystem).not.toContain('rgba(20,22,40');

    const widgetScope = balancedBlock(widget, '.wg {');
    const widgetFilter = customProperty(widgetScope, 'glass-filter');
    const widgetRow = customProperty(widgetScope, 'row-bg');
    const widgetRowHover = customProperty(widgetScope, 'row-bg-hover');
    expect(saturationPercent(widgetFilter)).toBeGreaterThanOrEqual(165);
    expect(saturationPercent(widgetFilter)).toBeLessThanOrEqual(180);
    expect(liquidGlassAlpha(widgetRow)).toBeCloseTo(0.82, 2);
    expect(liquidGlassAlpha(widgetRowHover)).toBeCloseTo(0.94, 2);
    expect(liquidGlassAlpha(widgetRow, 0)).toBe(1);
    expect(liquidGlassAlpha(widgetRowHover, 0)).toBe(1);

    expect(popover).toContain('--popover-blur: var(--glass-filter)');
    expect(popover).toContain('--popover-unread: var(--pop-text)');
    expect(popover).not.toMatch(/#(?:007aff|0a84ff|0a6cff)/i);
    expect(popoverWindow).toContain('class:native-glass={nativeGlass}');
    expect(popoverWindow).toMatch(
      /\.mbpop\.native-glass\s*\{[\s\S]*?backdrop-filter:\s*none;/,
    );
  });

  it('keeps every literal backdrop saturation live but restrained', () => {
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return (source.match(/(?:-webkit-)?backdrop-filter:[^;]+;/g) ?? [])
        .filter((declaration) => /saturate\(/.test(declaration))
        .filter((declaration) => {
          const saturation = saturationPercent(declaration);
          return saturation < 100 || saturation > 185;
        })
        .map((declaration) => `${relative(srcRoot, path)}: ${declaration.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps desktop aliases, shared windows, and fallback states free of cool tint', () => {
    expect(desktopCss).not.toMatch(/#0a6fd6/i);
    expect(desktopCss).toContain('--blue: var(--v4-text-1');
    expect(storyDetail).not.toMatch(/rgba\(\s*96,\s*165,\s*250/i);

    expect(widgetSettings).not.toMatch(/#(?:1d1d1f|111113)/i);
    expect(widget).not.toMatch(/rgba\(\s*20,\s*22,\s*40/i);
    expect(onboarding).not.toMatch(/rgba\(\s*20,\s*22,\s*40/i);
    expect(onboarding).not.toMatch(/rgba\(\s*202,\s*165,\s*61|#9a7a1c/i);
    expect(globalError).not.toMatch(/#(?:09090b|d4d4d8|a1a1aa|f4f4f5)/i);

    expect(popoverWindow).not.toMatch(/#18181b/i);
    expect(bannerNotification).not.toMatch(
      /#(?:dce8ff|1c3d80)|rgba\(\s*(?:120,\s*170,\s*255|40,\s*90,\s*200)/i,
    );
    expect(driftDetail).not.toMatch(
      /#(?:a0a0b0|9cc7ff)|rgba\(\s*(?:18,\s*18,\s*20|96,\s*165,\s*250)/i,
    );
    expect(meetingsWindow).not.toMatch(
      /color:\s*#(?:93c5fd|bfdbfe)|(?:background|border-color):\s*rgba\(\s*96,\s*165,\s*250/i,
    );
  });

  it('keeps every shipped CSS/Svelte fallback achromatic outside brand marks', () => {
    const forbiddenCoolLiterals =
      /#(?:a0a0b0|bcd4ff|dce8ff|e8e8ee|6aa1ff|3f3f46|374151|6b7280|6366f1|818cf8|a78bfa|7c3aed|7e8cff|b9b9c0|76767c|c2c2c8|f2f2f4|8a8a90|8a8a92)\b/i;
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
      const match = source.match(forbiddenCoolLiterals);
      return match ? [`${relative(srcRoot, path)}: ${match[0]}`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it('keeps the visual verification harness neutral so previews do not fake a blue cast', () => {
    expect(harness).toContain('#3a3a3a');
    expect(harness).toContain('#1a1a1a');
    expect(harness).toContain('#0c0c0c');
    expect(harness).toContain('#ededed');
    expect(harness).toContain('#d4d4d4');
    expect(harness).toContain('#bcbcbc');
    expect(harness).toContain('#161616');
    expect(harness).toContain('#565656');
    expect(harness).toContain('#292929');

    expect(harness).not.toMatch(
      /#(?:3a3a52|1a1a24|0c0c12|e9e9f2|d2d2e0|b9b9cc|161618|4a5a7a|232838)/i,
    );
  });

  it('uses semantic color as a compact cue, never as a broad moderation action surface', () => {
    const approveRule = moderationPanel.match(/\.approve\s*\{([\s\S]*?)\}/)?.[1] ?? '';
    const confirmYankRule =
      moderationPanel.match(/\.confirm-yank\s*\{([\s\S]*?)\}/)?.[1] ?? '';

    expect(approveRule).toContain('background: var(--v4-primary-bg)');
    expect(approveRule).not.toContain('background: var(--v4-ok)');
    expect(confirmYankRule).toContain('background: var(--v4-primary-bg)');
    expect(confirmYankRule).not.toContain('background: var(--v4-warn)');
    expect(moderationPanel).toContain('.approve::before');
    expect(moderationPanel).toContain('.confirm-yank::before');
  });
});
