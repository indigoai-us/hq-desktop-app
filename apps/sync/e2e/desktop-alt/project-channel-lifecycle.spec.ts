import { describe, expect, it } from 'vitest';
import { readRepoFile } from './harness';

/**
 * US-005 — Desktop: project channel lifecycle + status popover (source contracts).
 *
 * Grep-the-source specs: lock create-project-channel flow, project header tabs,
 * status popover model, and hard UI rules on new chat files.
 */

function normalize(source: string): string {
  return source.replace(/\s+/g, ' ');
}

const chatSidebar = readRepoFile('src/desktop-alt/chat/ChatSidebar.svelte');
const createProject = readRepoFile('src/desktop-alt/chat/CreateProjectChannel.svelte');
const projectModel = readRepoFile('src/desktop-alt/chat/project-channel-model.ts');
const statusModel = readRepoFile('src/desktop-alt/chat/channel-status-model.ts');
const channelView = readRepoFile('src/components/messaging/ChannelView.svelte');
const channelsLib = readRepoFile('src/lib/channels.ts');
const messagesCmd = readRepoFile('src-tauri/src/commands/messages.rs');
const coreMessages = readRepoFile('../../crates/hq-desktop-core/src/messages.rs');

describe('US-005: create project channel flow', () => {
  it('exposes Project channel from the chat sidebar new-message path', () => {
    expect(chatSidebar).toContain('data-testid="chat-project-channel"');
    expect(chatSidebar).toContain('Project channel');
    expect(chatSidebar).toContain('CreateProjectChannel');
    expect(chatSidebar).toContain('createProjectChannelOpen');
    expect(chatSidebar).toContain('openProjectChannelCreate');
  });

  it('loads local projects and creates with scope=project + projectId + companyUid', () => {
    expect(createProject).toContain("loadLocalProjects");
    expect(createProject).toContain("invoke<MissionControlSnapshot>('list_agent_sessions')");
    expect(createProject).toContain("invoke<Channel>('create_channel'");
    expect(createProject).toContain("scope: payload.scope");
    expect(createProject).toContain('projectId: payload.projectId');
    expect(createProject).toContain('RecipientPicker');
    expect(createProject).toContain('data-testid="create-project-channel"');
    expect(createProject).toContain('data-testid="project-channel-picker"');
    expect(createProject).toContain('data-testid="project-channel-create"');
  });

  it('builds invite-only project payload in pure model', () => {
    expect(projectModel).toContain("scope: 'project'");
    expect(projectModel).toContain('projectId');
    expect(projectModel).toContain('companyUid');
    expect(projectModel).toContain('buildCreateProjectChannelPayload');
    expect(projectModel).toContain('defaultChannelNameFromProject');
    expect(projectModel).toContain('agentsForProject');
    expect(projectModel).toContain('resolveCompanyUidForProject');
  });

  it('Rust create_channel accepts project scope + optional project_id', () => {
    expect(messagesCmd).toContain('project_id: Option<String>');
    expect(messagesCmd).toContain('"project"');
    expect(messagesCmd).toContain('build_create_payload_with_project');
    expect(coreMessages).toContain('build_create_payload_with_project');
    expect(coreMessages).toContain('"projectId"');
    expect(coreMessages).toContain('pub project_id: Option<String>');
    expect(channelsLib).toContain("scope: 'personal' | 'company' | 'group' | 'project' | string");
    expect(channelsLib).toContain('projectId?: string | null');
  });
});

describe('US-005: project channel header + tabs', () => {
  it('renders # name · company · project channel with Chat | Board | Files', () => {
    expect(channelView).toContain('projectChannelHeaderTitle');
    expect(channelView).toContain('data-testid="project-channel-title"');
    expect(channelView).toContain('data-testid="project-channel-tabs"');
    expect(channelView).toContain('>Chat<');
    expect(channelView).toContain('>Board<');
    expect(channelView).toContain('>Files<');
    // US-006/US-008: the tab-body testids moved onto the live BoardTab /
    // ChannelFilesTab roots when the placeholders were replaced.
    expect(channelView).toContain('<BoardTab');
    expect(channelView).toContain('<ChannelFilesTab');
    expect(statusModel).toContain('projectChannelHeaderTitle');
    expect(statusModel).toContain('project channel');
  });

  it('member-count button opens status popover for project channels', () => {
    expect(channelView).toContain('data-testid="channel-member-count"');
    expect(channelView).toContain('openMembersSurface');
    expect(channelView).toContain('data-testid="project-status-popover"');
    expect(channelView).toContain('isProjectChannel');
    expect(channelView).toContain('buildChannelStatusModel');
  });
});

describe('US-005: status popover model contracts', () => {
  it('derives live agent rows, story rollup, project block, members + agents', () => {
    expect(statusModel).toContain('buildChannelStatusModel');
    expect(statusModel).toContain('liveAgents');
    expect(statusModel).toContain('Agent ${verb}');
    expect(statusModel).toContain('stories ${complete}/${total}');
    expect(statusModel).toContain('branch');
    expect(statusModel).toContain('repo');
    expect(statusModel).toContain('previewUrl');
    expect(statusModel).toContain('resolvePreviewUrl');
    expect(statusModel).toContain('sessionMatchesProject');
    // Model is pure — no Tauri imports.
    expect(statusModel).not.toContain('@tauri-apps/api');
    expect(statusModel).not.toContain('invoke(');
  });

  it('ChannelView status popover shows progress bar, project fields, members, agents', () => {
    expect(channelView).toContain('status-progress');
    expect(channelView).toContain('role="progressbar"');
    expect(channelView).toContain('>Branch<');
    expect(channelView).toContain('>Repo<');
    expect(channelView).toContain('Open preview');
    expect(channelView).toContain('>Members<');
    expect(channelView).toContain('>Agents<');
    expect(channelView).toContain("loadLocalProjectPrd");
    expect(channelView).toContain("list_agent_sessions");
  });
});

describe('US-005: hard UI rules on new project-channel files', () => {
  it('create sheet and status popover use border-radius 0 on structural surfaces', () => {
    expect(createProject).toMatch(/\.pc-sheet\s*\{[\s\S]*?border-radius:\s*0/);
    expect(createProject).toMatch(/\.pc-row\s*\{[\s\S]*?border-radius:\s*0/);
    expect(channelView).toMatch(/\.status-popover\s*\{[\s\S]*?border-radius:\s*0/);
  });

  it('never uses font-weight above 500 in create sheet + new status/project styles', () => {
    const createWeights = [...createProject.matchAll(/font-weight:\s*([0-9]+)/g)].map((m) =>
      Number(m[1]),
    );
    expect(createWeights.length).toBeGreaterThan(0);
    for (const w of createWeights) {
      expect(w, `CreateProjectChannel font-weight ${w} exceeds 500`).toBeLessThanOrEqual(500);
    }
    expect(createProject).not.toMatch(/font-weight:\s*(bold|bolder|600|700|800|900)/i);

    // Only the US-005 surfaces added in ChannelView (project tabs + status popover).
    const us005Blocks = [
      ...channelView.matchAll(
        /\.(?:project-tab|project-placeholder|status-[\w-]+)\s*\{[^}]*font-weight:\s*([0-9]+)/g,
      ),
    ].map((m) => Number(m[1]));
    expect(us005Blocks.length).toBeGreaterThan(0);
    for (const w of us005Blocks) {
      expect(w, `US-005 ChannelView style font-weight ${w} exceeds 500`).toBeLessThanOrEqual(500);
    }
  });

  it('stays monochrome without accent bars on create sheet', () => {
    expect(createProject).not.toMatch(/border-left:\s*[0-9]+px\s+solid\s+#(f|e|c|a|9)/i);
    expect(createProject).not.toMatch(/--v4-brand-accent/);
    expect(normalize(statusModel)).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    expect(normalize(projectModel)).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });
});
