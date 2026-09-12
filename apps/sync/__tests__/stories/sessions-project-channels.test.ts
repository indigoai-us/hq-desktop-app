/**
 * Project channels ↔ sessions — the story pins.
 *
 * Owner's ask: expand a project channel in the sidebar and see its sessions;
 * spawn a session from a channel, bound to that project; when a session
 * creates a project, a channel can appear and the session shows linked to it.
 *
 * The sync suite runs in a node environment, so the Svelte wiring is pinned
 * at the source level; the pure decisions (row → project, the `new?…` param,
 * the badge) are imported and CALLED. Everything outward (creating a channel)
 * is pinned to the confirm click of the project-created card.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import {
  linkForRow,
  newSessionParam,
  rowExtrasFor,
  sessionsBadge,
  type ProjectLink,
} from '../../src/desktop-alt/lib/session-project-links';
import { parseSessionsParam } from '../../src/desktop-alt/pages/sessions-route-param';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

const SHELL = read('src/desktop-alt/HqWorkWorkShell.svelte');
const EXTRA = read('src/desktop-alt/pages/SessionsExtraPage.svelte');
const PAGE = read('src/desktop-alt/pages/SessionsPage.svelte');
const STRIP = read('src/components/sessions/SessionsStrip.svelte');
const CARD = read('src/components/sessions/ProjectCreatedCard.svelte');
const STORE = read('src/desktop-alt/lib/project-links-store.svelte.ts');
const UI_SIDEBAR = read('../../packages/ui/src/chat/ChatSidebar.svelte');
const UI_DESKTOP = read('../../packages/ui/src/shell/DesktopApp.svelte');
const UI_ROW_EXTRAS = read('../../packages/ui/src/chat/row-extras.ts');
const VENDORED = read('../../packages/VENDORED.md');
const MAIN_RS = read('src-tauri/src/main.rs');
const LINKS_RS = read('src-tauri/src/commands/session_project_links.rs');
const AGENT_RS = read('src-tauri/src/commands/agent_session.rs');

const launch: ProjectLink = {
  project: 'launch',
  projectName: 'Launch',
  projectPath: '/hq/companies/indigo/projects/launch',
  channelId: 'chn_launch',
  channelName: 'p-launch',
  sessions: [
    { sessionId: 's-live', tool: 'claude', phase: 'working', startedAt: '2026-09-02T09:00:00Z' },
    { sessionId: 's-done', tool: 'codex', phase: 'ended', startedAt: '2026-09-01T09:00:00Z' },
  ],
};

describe('expand a project channel → its nested sessions', () => {
  it('the shared sidebar gained ONE generic seam, registered as a vendored divergence', () => {
    expect(UI_ROW_EXTRAS).toContain('export type RowExtrasResolver');
    expect(UI_ROW_EXTRAS).toContain('children?: ConversationRowChild[]');
    expect(UI_DESKTOP).toContain('rowExtras?: RowExtrasResolver | null');
    expect(UI_DESKTOP).toContain('rowExtras?.(row, view === "extra"');
    expect(UI_SIDEBAR).toContain('data-testid="chat-row-extra-badge"');
    expect(UI_SIDEBAR).toContain('data-testid="chat-row-children-toggle"');
    expect(UI_SIDEBAR).toContain('data-testid="chat-row-children"');
    expect(UI_SIDEBAR).toContain('data-testid="chat-row-child"');
    expect(UI_SIDEBAR).toContain('margin: 0 0 4px 16px');
    expect(UI_SIDEBAR).toContain('grid-template-columns: 16px minmax(0, 1fr) auto');
    expect(UI_SIDEBAR).toContain('aria-current={child.selected ? "page" : undefined}');
    expect(UI_SIDEBAR).toContain('border: 0;');
    expect(UI_SIDEBAR).not.toContain('border-left: 1px solid var(--line)');
    expect(UI_SIDEBAR).toContain('data-testid={`chat-context-action-${action.id}`}');
    // Tauri-free, session-free: the shell mounts what it is handed.
    for (const source of [UI_SIDEBAR, UI_DESKTOP, UI_ROW_EXTRAS]) {
      expect(source).not.toContain('@tauri-apps/');
      expect(source).not.toContain('session_project_links');
    }
    expect(VENDORED).toContain('`rowExtras`');
    expect(VENDORED).toContain('DesktopApp.row-extras.test.ts');
  });

  it('the host resolves a sidebar row to its project and nests its sessions plus New session', () => {
    const row = {
      id: 'ch:chn_launch',
      kind: 'channel' as const,
      title: 'p-launch',
      companyUid: 'cmp_1',
      unreadDot: false,
      lastActivityAt: 0,
      pinned: false,
      channelId: 'chn_launch',
    };
    expect(linkForRow(row, [launch])).toBe(launch);
    expect(sessionsBadge(launch)).toBe('1 live');
    const opened: string[] = [];
    const spawned: string[] = [];
    const extras = rowExtrasFor(
      row,
      [launch],
      null,
      (link) => spawned.push(link.project),
      (_link, session) => opened.push(session.sessionId),
    );
    expect(extras?.children?.map((child) => child.id)).toEqual([
      'session:s-live',
      'new-session',
    ]);
    extras?.children?.[0]?.onselect();
    extras?.children?.at(-1)?.onselect();
    expect(opened).toEqual(['s-live']);
    expect(spawned).toEqual(['launch']);
  });

  it('the shell builds rowExtras from session_project_links and refreshes on phase edges + every 30 s', () => {
    expect(SHELL).toContain('const rowExtras = $derived.by<RowExtrasResolver | null>');
    expect(SHELL).toContain('rowExtrasFor(');
    expect(SHELL).toContain('param: historySessionParam(company, _link.project, session)');
    expect(SHELL).toContain('projectLinksStore.start(slugs)');
    expect(SHELL).toContain('return () => projectLinksStore.stop()');
    expect(STORE).toContain("invoke<ProjectLink[]>('session_project_links'".replace('invoke<ProjectLink[]>', '').slice(0, 0) + 'loadSessionProjectLinks(company)');
    expect(STORE).toContain("const PHASE_EVENT = 'agent-session:phase'");
    expect(STORE).toContain('export const LINKS_REFRESH_MS = 30_000');
    expect(STORE).toContain("area: 'session-project-links'");
    expect(UI_SIDEBAR).not.toContain('Some project sessions');
    expect(SHELL).not.toContain('rowExtrasError={Boolean(workspaceError)');
    expect(MAIN_RS).toContain('commands::session_project_links::session_project_links,');
    expect(LINKS_RS).toContain('pub const CACHE_TTL: Duration = Duration::from_secs(10)');
  });
});

describe('spawn a session from a channel, bound to that project', () => {
  it('the "New session" action navigates to a pre-bound fresh chat the page decodes', () => {
    const param = newSessionParam('indigo', 'launch', 'chn_launch');
    expect(parseSessionsParam(param)).toEqual({ kind: 'new', company: 'indigo', project: 'launch', channelId: 'chn_launch' });
    expect(param.startsWith('new?company=indigo&project=launch&channel=chn_launch')).toBe(true);
    expect(param).toContain('draft=');
    expect(SHELL).toContain('param: newSessionParam(company, link.project, link.channelId)');
    expect(EXTRA).toContain('parseSessionsParam(param)');
    expect(EXTRA).toContain("initialCompany={route.kind === 'new' ? route.company : route.kind === 'session' ? (route.company ?? null) : null}");
    expect(EXTRA).toContain("initialProject={route.kind === 'new' ? route.project : null}");
    expect(EXTRA).toContain("initialChannelId={route.kind === 'new' ? route.channelId : undefined}");
  });

  it('the page seeds the company + project pills from the route and binds the spec to the project', () => {
    expect(PAGE).toContain('initialCompany?: string | null');
    expect(PAGE).toContain('initialProject?: string | null');
    expect(PAGE).toContain('company = initialCompany;');
    expect(PAGE).toContain('project = projectNameFor(projects, slug) ?? slug;');
    // The first send orients with `/startwork {company} {project}`, and the
    // spec carries the directory slug the channel is named from.
    expect(PAGE).toContain('!embedded && startworkEnabled && !setupChat');
    expect(PAGE).toContain('project: projectSlugFor(projects, project),');
    expect(AGENT_RS).toContain('spec.project.as_deref(),');
  });
});

describe('a project created in a session → a channel', () => {
  it('Rust detects a NEW prd.json and notifies only explicitly bound sessions without rebinding', () => {
    expect(LINKS_RS).toContain('pub const EVENT_PROJECT_CREATED: &str = "agent-session:project-created"');
    expect(LINKS_RS).toContain('WATCH_INTERVAL: Duration = Duration::from_secs(5)');
    expect(LINKS_RS).toContain('sessions_for_project(');
    expect(LINKS_RS.split('#[cfg(test)]')[0]).not.toContain('bind_session_project(');
    expect(MAIN_RS).toContain('commands::session_project_links::setup_project_watch(app.handle().clone());');
  });

  it('the card offers the channel and creates it ONLY on confirm, through the share path, no transcript', () => {
    expect(PAGE).toContain('<ProjectCreatedCard');
    expect(CARD).toContain("listen<ProjectCreatedNotice>(PROJECT_CREATED_EVENT");
    expect(CARD).toContain('data-testid="session-project-create-channel"');
    const confirm = CARD.slice(CARD.indexOf('async function confirm()'), CARD.indexOf('function retry()'));
    expect(confirm).toContain('liveSessionStore.shareToChannel({');
    expect(confirm).toContain("target: { kind: 'new', name: '', projectPath: notice.projectPath }");
    expect(confirm).toContain('includeTranscript: false');
    expect(confirm).toContain('inviteUids: []');
    // Never from an effect: the only caller is the click handler.
    expect(CARD.match(/void confirm\(\)/g)).toHaveLength(1);
    expect(CARD).toContain('onclick={() => void confirm()}');
    // An existing channel is linked, not re-created.
    expect(CARD).toContain('settle(notice, link.channelId, link.channelName ?? link.channelId, false)');
    expect(CARD).toContain("{card.created ? 'has its channel' : 'is linked'}");
  });

  it('the shell paints the new channel row and reconciles the directory when the card links one', () => {
    expect(SHELL).toContain('window.addEventListener(PROJECT_CHANNEL_LINKED_EVENT, onProjectChannelLinked)');
    expect(SHELL).toContain("wakes.emit?.('channel:updated', {");
    expect(SHELL).toContain("wakes.emit?.('channel:unread-changed', undefined)");
    expect(SHELL).toContain('window.removeEventListener(PROJECT_CHANNEL_LINKED_EVENT, onProjectChannelLinked)');
  });
});

describe('the strip shows the bound project', () => {
  it('as a pill beside the company that opens the project channel when one exists', () => {
    expect(STRIP).toContain('data-testid="sessions-project-pill"');
    expect(STRIP).toContain('disabled={!projectLinked}');
    expect(PAGE).toContain('projectLabel={sessionId ? (summary?.project ?? null) : null}');
    expect(PAGE).toContain('projectLinked={Boolean(projectLink?.channelId)}');
    expect(PAGE).toContain('if (channelId) onopenchannel?.(channelId);');
  });
});
