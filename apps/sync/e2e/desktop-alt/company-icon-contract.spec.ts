// Source contract for the company icon.
//
// A company channel is identified by its company's website favicon, falling
// back to a building glyph — never the generic `#`, which said nothing about
// WHICH company you were looking at. Several invariants here are the kind that
// only break silently (a widened CSP, an icon rendered from a url the packaged
// app cannot paint, the `#` creeping back onto company rows), so they are
// pinned against the real source rather than left to a mounted component.

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readRepoFile } from './harness';

const ui = (rel: string) => readRepoFile(join('../../packages/ui', rel));

const MARKETPLACE_ORIGIN =
  'https://hq-marketplace-assets-hq-prod.s3.us-east-1.amazonaws.com';

describe('company icon — component contract', () => {
  const component = ui('src/company/CompanyIcon.svelte');

  it('ships a CompanyIcon component with an image and a glyph branch', () => {
    expect(component).toContain('class="company-icon-img"');
    expect(component).toContain('class="company-icon-glyph"');
    expect(component).toContain("data-testid=\"company-icon\"");
  });

  it('routes every url through companyIconSrc rather than binding raw', () => {
    // Binding `iconUrl` straight into src would let a non-allowlisted origin
    // through and fail silently under the packaged CSP.
    expect(component).toContain('import { companyIconSrc }');
    expect(component).toContain('companyIconSrc(iconUrl)');
    expect(component).toContain('src={safeSrc}');
    expect(component).not.toContain('src={iconUrl}');
  });

  it('falls back to the glyph when the image errors', () => {
    expect(component).toContain('onerror=');
    expect(component).toMatch(/brokenSrc\s*=\s*safeSrc/);
  });

  it('draws the building as inline SVG with the house stroke dialect', () => {
    // 16-unit viewBox + currentColor + round joins, matching the icon set. No
    // icon dependency is introduced.
    expect(component).toContain('viewBox="0 0 16 16"');
    expect(component).toContain('stroke="currentColor"');
    expect(component).toContain('stroke-width="1.5"');
    // The same office mark the Settings "companies" nav icon uses.
    expect(component).toContain('M2.5 13.5V6.5L8 3l5.5 3.5v7H2.5Z');
  });

  it('rounds the icon at 4px', () => {
    expect(component).toContain('border-radius: 4px');
  });

  it('does not import any icon package', () => {
    expect(component).not.toMatch(/from\s+["'](lucide|phosphor|@iconify)/);
  });
});

describe('company icon — CSP delivery plane', () => {
  const csp = ui('src/avatars/csp-image-src.ts');

  it('accepts ONLY the branding prefix on the allowlisted assets host', () => {
    expect(csp).toContain('export function companyIconSrc');
    expect(csp).toContain("pathname.startsWith(\"/branding/\")");
  });

  it('keeps the packaged img-src pinned to the assets origin only', () => {
    // The icon is delivered as a presigned GET on the host that is ALREADY
    // allowlisted, precisely so this policy never has to widen. hq-pro's
    // durable brand.faviconUrl (an api-host path) is deliberately unpaintable.
    const conf = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
      app?: { security?: { csp?: string } };
    };
    const imgSrc = conf.app?.security?.csp?.match(
      /(?:^|;)\s*img-src\s+([^;]+)/i,
    )?.[1];
    expect(imgSrc).toBeTruthy();
    const remote = imgSrc!
      .trim()
      .split(/\s+/)
      .filter((source) => /^https?:/i.test(source));
    expect(remote).toEqual([MARKETPLACE_ORIGIN]);
  });
});

describe('company icon — server contract threading', () => {
  it('types iconUrl as optional AND nullable on the directory row', () => {
    // Absent = older server; null = company has no icon. Both must be legal so
    // the desktop renders against a v-old and a new server alike.
    const reconciler = ui('src/chat/channel-directory-reconciler.ts');
    expect(reconciler).toMatch(/iconUrl\?:\s*string\s*\|\s*null;/);
  });

  it('normalizes iconUrl off the row or the nested directoryRow', () => {
    const live = ui('src/chat/live-directory.ts');
    expect(live).toContain('rec.iconUrl ?? rec.icon_url');
    expect(live).toContain('nested?.iconUrl');
  });

  it('carries iconUrl on Channel, ConversationRow, ScopeCompany and Workspace', () => {
    expect(ui('src/chat/channels.ts')).toMatch(/iconUrl\?:\s*string\s*\|\s*null;/);
    expect(ui('src/chat/workspaces.ts')).toMatch(
      /iconUrl\?:\s*string\s*\|\s*null;/,
    );
    const model = ui('src/chat/sidebar-model.ts');
    expect(model).toMatch(/iconUrl\?:\s*string\s*\|\s*null;/);
    // ConversationRow richness must include it, or a deep-link stub and a live
    // row can oscillate.
    expect(model).toMatch(/CONVERSATION_ROW_RICHNESS_FIELDS[\s\S]*?"iconUrl"/);
  });

  it('reads iconUrl from the every-plan membership roster, not the brand gate', () => {
    // brandingEnabled is the Enterprise white-label entitlement; the company
    // icon is an every-plan field and must never be gated on it.
    const map = ui('src/company/company-display-map.ts');
    expect(map).toContain('export function buildCompanyIconMap');
    expect(map).toContain('export function companyIconUrl');
    expect(map).not.toMatch(/buildCompanyIconMap[\s\S]{0,600}brandingEnabled/);
  });
});

describe('company icon — surfaces', () => {
  const sidebar = ui('src/chat/ChatSidebar.svelte');
  const shell = ui('src/shell/DesktopApp.svelte');

  it('replaces the rail # for COMPANY-scoped rows only', () => {
    expect(sidebar).toContain('isCompanyScopedRow(row)');
    expect(sidebar).toContain('<CompanyIcon iconUrl={rowCompanyIcon(row)}');
    // Project / personal / agent channels keep the generic hash.
    expect(sidebar).toContain('<span class="chat-glyph">#</span>');
    expect(sidebar).toMatch(
      /isCompanyScopedRow[\s\S]{0,400}channelScope[\s\S]{0,80}"company"/,
    );
  });

  it('renders the mark in the scope switcher menu', () => {
    expect(sidebar).toContain('scopeOptionIcon(option.id)');
    expect(sidebar).toContain('<CompanyIcon iconUrl={scopeOptionIcon(option.id)}');
  });

  it('renders the mark in the channel header for company channels', () => {
    expect(shell).toContain('selectedIsCompanyChannel');
    expect(shell).toContain('<CompanyIcon iconUrl={selectedCompanyIcon}');
    // The plain hash survives for non-company channels.
    expect(shell).toContain('<span class="channel-hash" aria-hidden="true">#</span>');
  });

  it('renders the mark on cmd-K company rows', () => {
    expect(ui('src/shell/palette-rows.ts')).toContain(
      'export function paletteRowIconUrl',
    );
    expect(shell).toContain('showCompanyMark:');
    expect(ui('src/common/CommandPalette.svelte')).toContain(
      'command.showCompanyMark',
    );
  });

  it('renders the mark in the company member popover', () => {
    expect(ui('src/chat/channel-status-model.ts')).toMatch(
      /companyIconUrl\?:\s*string\s*\|\s*null;/,
    );
    const popover = ui('src/chat/ChannelStatusPopover.svelte');
    expect(popover).toContain('data-testid="status-company"');
    expect(popover).toContain('<CompanyIcon iconUrl={model.companyIconUrl');
  });

  it('sizes the mark 16px in the rail and larger in headers/switcher/cmd-K', () => {
    expect(sidebar).toContain('size={16}');
    expect(sidebar).toContain('size={24}');
    expect(shell).toContain('size={22}');
    expect(ui('src/common/CommandPalette.svelte')).toContain('size={20}');
  });
});
