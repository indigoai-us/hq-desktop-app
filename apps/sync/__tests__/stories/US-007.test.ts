import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../src/lib/workspaces';
import {
  COMPANY_SECTIONS,
  getDesktopActiveCompany,
  getDesktopCompanies,
  getDesktopSecondarySidebar,
} from '../../src/desktop-alt/route';
import { emptyCompanySummary } from '../../src/desktop-alt/lib/company-summary.svelte';

function readIfExists(p: string): string {
  try {
    return readFileSync(resolve(process.cwd(), p), 'utf8');
  } catch {
    return '';
  }
}

const companyPage = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/pages/CompanyPage.svelte'),
  'utf8',
);
const companySummary = readFileSync(
  resolve(process.cwd(), 'src/desktop-alt/lib/company-summary.svelte.ts'),
  'utf8',
);
const desktopApp = readFileSync(resolve(process.cwd(), 'src/desktop-alt/DesktopApp.svelte'), 'utf8');
const workspaceTypes = readFileSync(resolve(process.cwd(), 'src/lib/workspaces.ts'), 'utf8');
const workspaceCommand =
  readIfExists('src-tauri/src/commands/workspaces.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/workspaces.rs');
const desktopAltCommand =
  readIfExists('src-tauri/src/commands/desktop_alt.rs') +
  '\n' +
  readIfExists('../../crates/hq-desktop-core/src/desktop_alt.rs');
const tauriMain = readFileSync(resolve(process.cwd(), 'src-tauri/src/main.rs'), 'utf8');

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    slug: 'acme',
    displayName: 'Acme Corp',
    kind: 'company',
    state: 'synced',
    cloudUid: 'cloud-acme',
    bucketName: 'hq-acme',
    hasLocalFolder: true,
    localPath: '/Users/test/HQ/companies/acme',
    membershipStatus: 'active',
    role: 'admin',
    lastSyncedAt: null,
    brokenReason: null,
    invitedBy: null,
    invitedAt: null,
    ...overrides,
  };
}

describe('US-007: Company page shell — V4 sections + crumb (sections moved to the secondary sidebar in US-002)', () => {
  it('renders the company shell with the crumb and the company sections when a sidebar company is selected', () => {
    const workspaces: Workspace[] = [
      workspace({ slug: 'personal', displayName: 'Personal', kind: 'personal', role: null }),
      workspace({ slug: 'acme', displayName: 'Acme Corp', role: 'admin' }),
    ];
    const companies = getDesktopCompanies(workspaces);

    expect(getDesktopActiveCompany({ kind: 'company', slug: 'acme' }, companies)).toMatchObject({
      slug: 'acme',
      role: 'admin',
    });

    const page = normalize(companyPage);
    expect(page).toContain('<h1 id="company-page-title" class="visually-hidden">{company.displayName}</h1>');
    expect(page).toContain('<header class="company-actions-row">');
    // Company actions: Invite + New project stay on the toolbar (DESKTOP-003);
    // Settings / operational controls live under sidebar More. Console settings
    // helper remains for the company settings URL path.
    expect(page).toContain("import { open as openExternal } from '@tauri-apps/plugin-shell';");
    expect(page).toContain('<button type="button" onclick={openInvite}>Invite</button>');
    expect(page).not.toContain(
      '<button type="button" onclick={openCompanySettings}>Settings</button>',
    );
    expect(page).toContain('onclick={() => void startNewProject()}');

    // DESKTOP-001: company sections expand inline under the selected company;
    // there is no permanent company secondary sidebar. Full section list remains
    // route-supported (deep links / More / palette).
    expect(COMPANY_SECTIONS.map((section) => section.id)).toEqual([
      'overview',
      'goals',
      'projects',
      'skills',
      'workers',
      'knowledge',
      'team',
      'activity',
      'deployments',
      'secrets',
      'settings',
    ]);
    expect(getDesktopSecondarySidebar({ kind: 'company', slug: 'acme' }, companies)).toBeNull();
    expect(getDesktopActiveCompany({ kind: 'company', slug: 'acme' }, companies)?.role).toBe(
      'admin',
    );
  });

  it('swaps the selected panel when a section is selected from the secondary sidebar', () => {
    const page = normalize(companyPage);
    const desktop = normalize(desktopApp);

    // The route drives the section; the in-page segmented control is gone.
    expect(page).toContain('tab = DEFAULT_COMPANY_TAB');
    expect(page).not.toContain('CompanyTabs');
    // Knowledge intercept may appear first; company tab navigate still present.
    expect(desktop).toContain("tab: id as CompanyTab");
    expect(desktop).toContain("kind: 'company'");
    expect(desktop).toContain('<CompanyPage');
    expect(desktop).toContain('company={activeCompany}');
    expect(desktop).toContain('tab={companyTab}');

    // The company page opens on the Overview board (company-scoped goals/
    // projects/in-flight via CompanyBoardPanel). The old flat vault BoardPanel
    // stays retired.
    expect(page).not.toContain('<BoardPanel slug={company.slug} />');
    // DESKTOP-010: Activity / Deployments / Secrets / Settings live under More
    // via CompanyOperationsPanel (child panels still preserve backend wiring).
    expect(page).toContain("import CompanyOperationsPanel from '../panels/CompanyOperationsPanel.svelte'");
    expect(page).toContain('<CompanyBoardPanel');
    expect(page).toContain('slug={company.slug}');
    expect(page).toContain('{cloudBacked}');
    expect(page).toContain('isCompanyOperationsTab(tab)');
    expect(page).toContain('<CompanyOperationsPanel');
    expect(page).toContain('destination={operationsDestination}');
  });

  it('wires company metadata plus workspace role propagation', () => {
    const page = normalize(companyPage);
    const summary = normalize(companySummary);
    const desktop = normalize(desktopApp);
    const workspaceSrc = normalize(workspaceTypes);
    const rustWorkspaces = normalize(workspaceCommand);
    const rustDesktopAlt = normalize(desktopAltCommand);
    const rustMain = normalize(tauriMain);

    expect(emptyCompanySummary()).toEqual({
      board: 0,
      activity: { last7d: 0 },
      deployments: 0,
      secrets: 0,
    });
    expect(summary).toContain("void invoke<CompanySummary>('get_company_summary', { slug })");
    expect(summary).toContain('summary = emptyCompanySummary();');
    // company-summary was refactored from an effect-cleanup `cancelled` flag to
    // a monotonic request id that discards out-of-order completions.
    expect(summary).toContain('const myRequest = ++requestId;');
    expect(summary).toContain('if (myRequest === requestId) {');
    expect(rustDesktopAlt).toContain('pub struct CompanySummary');
    expect(rustDesktopAlt).toContain('pub async fn get_company_summary(slug: String) -> Result<CompanySummary, String>');
    expect(rustMain).toContain('commands::desktop_alt::get_company_summary');
    // Company settings now opens the HQ web console (sync rules / members /
    // roles live there) in the system browser, not an in-app settings route.
    expect(page).toContain('void openExternal(companySettingsUrl(company.slug));');
    expect(page).toContain('onopenprojects?: () => void;');
    expect(page).toContain("const settings = await invoke<SettingsWire>('get_settings').catch(() => ({ hqPath: null }));");

    expect(desktop).toContain("invoke<WorkspacesResult>('list_syncable_workspaces')");
    expect(workspaceSrc).toContain('role: string | null;');
    expect(rustWorkspaces).toContain('pub role: Option<String>');
    // US-004 (V4) hoisted the per-slug membership lookup so role + invite
    // metadata derive from one find — same propagation, new contract.
    expect(rustWorkspaces).toMatch(
      /let membership_for_slug = cloud_entity_for_slug[\s\S]*let role = membership_for_slug\.and_then\(\|m\| m\.role\.clone\(\)\)/,
    );
  });
});
