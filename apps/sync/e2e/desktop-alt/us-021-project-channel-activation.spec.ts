import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-021 — auto-activate project channels + owner filter (source contracts).
 *
 * Locks: the debounced/idempotent ensure-project provisioning path (silent
 * no-op against old servers), the owner/admin-gated "All company projects"
 * filter option, and the browse-only row model that keeps other members'
 * project channels out of the default views.
 */

const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
const sidebarModel = readRepoFile('src/desktop-alt/chat/sidebar-model.ts');
const provisioning = readRepoFile('src/desktop-alt/chat/channel-provisioning.ts');

describe('US-021: project-channel auto-activation', () => {
  it('exports the debounced idempotent provisioner + target mapping', () => {
    expect(provisioning).toContain('export function createProjectChannelProvisioner');
    expect(provisioning).toContain('export function collectEnsureTargets');
    expect(provisioning).toContain("'ensure_project_channel'");
    // Per-session dedupe + debounce seams.
    expect(provisioning).toContain('debounceMs');
    expect(provisioning).toContain('done.has(key)');
  });

  it('ChatSidebar provisions member project channels on list load', () => {
    expect(chatSidebar).toContain('createProjectChannelProvisioner');
    expect(chatSidebar).toContain('provisionProjectChannels');
    expect(chatSidebar).toContain("invoke<LocalProjectLike[] | null>('get_local_projects')");
    expect(chatSidebar).toContain('void provisionProjectChannels()');
    expect(chatSidebar).toContain('channelProvisioner.dispose()');
  });
});

describe('US-021: owner filter — All company projects', () => {
  it('sidebar model gains the company-projects show filter + browse-only rows', () => {
    expect(sidebarModel).toContain(
      "export type ShowFilter = 'all' | 'projects' | 'dms' | 'company-projects'",
    );
    expect(sidebarModel).toContain('browseOnly?: boolean');
  });

  it('popover option is gated to org owners/admins', () => {
    expect(chatSidebar).toContain('data-testid="chat-filter-company-projects"');
    expect(chatSidebar).toContain('{#if canSeeCompanyProjects}');
    expect(chatSidebar).toContain('adminCompanyUids');
    expect(chatSidebar).toContain('All company projects');
  });

  it('owner listing fetch is additive + absent-safe', () => {
    expect(chatSidebar).toContain('includeCompanyProjects: true');
    expect(chatSidebar).toContain('browseOnlyCompanyProjectChannels');
  });
});
