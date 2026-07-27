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

describe('DESKTOP-012: neutral liquid-glass materials', () => {
  const tokens = readRepoFile('src/desktop-alt/v4/tokens.css');
  const designSystem = readRepoFile('src/styles/design-system.css');
  const popover = readRepoFile('src/styles/popover.css');
  const titleBar = readRepoFile('src/desktop-alt/v4/V4TitleBar.svelte');
  const sidebar = readRepoFile('src/desktop-alt/v4/V4Sidebar.svelte');
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
    expect(tokens).toContain('--v4-ground: rgba(242, 242, 242, 0.82)');
    expect(tokens).toContain('--v4-raised: rgba(255, 255, 255, 0.62)');
    expect(tokens).toContain('--v4-chrome: rgba(232, 232, 232, 0.66)');
    expect(tokens).toContain('--v4-ground: rgba(17, 17, 17, 0.82)');
    expect(tokens).toContain('--v4-raised: rgba(48, 48, 48, 0.62)');
    expect(tokens).toContain('--v4-chrome: rgba(30, 30, 30, 0.68)');
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

  it('defines one neutral glass stack and routes every desktop chrome layer through it', () => {
    expect(tokens).toContain('--v4-glass-filter: blur(28px) saturate(0%)');
    expect(tokens).toContain('--v4-glass-filter-soft: blur(12px) saturate(0%)');
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
    expect(canvasRule).toContain('backdrop-filter: var(--v4-glass-filter)');
    expect(canvasRule).toContain('-webkit-backdrop-filter: var(--v4-glass-filter)');
  });

  it('keeps the shared popover system achromatic instead of reintroducing blue tint', () => {
    expect(designSystem).toContain('--page-bg:#eeeeee');
    expect(designSystem).toContain('--pop-bg:rgba(250,250,250,0.68)');
    expect(designSystem).toContain('--glass-filter:blur(28px) saturate(0%)');
    expect(designSystem).not.toContain('rgba(20,22,40');

    expect(popover).toContain('--popover-blur: var(--glass-filter)');
    expect(popover).toContain('--popover-unread: var(--pop-text)');
    expect(popover).not.toMatch(/#(?:007aff|0a84ff|0a6cff)/i);
  });

  it('does not color-amplify any glass surface in CSS or Svelte styles', () => {
    const srcRoot = join(process.cwd(), 'src');
    const offenders = sourceFiles(srcRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return (source.match(/(?:-webkit-)?backdrop-filter:[^;]+;/g) ?? [])
        .filter((declaration) => /saturate\(/.test(declaration))
        .filter((declaration) => !/saturate\((?:0|0%)\)/.test(declaration))
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
