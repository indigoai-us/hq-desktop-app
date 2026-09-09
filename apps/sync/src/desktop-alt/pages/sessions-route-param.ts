// The Sessions page's opaque `extraPages` param, decoded.
//
// Two shapes: a session id (open that session), or `new?company=…&project=…`
// (a fresh chat pre-bound to a company and, optionally, a project — what the
// sidebar's "New session" action on a project channel navigates to). Anything
// else is treated as a session id, which is what the page always did.

export type SessionsRoute =
  | { kind: 'shared'; sessionId: string; channelId: string }
  | { kind: 'empty' }
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'history';
      sessionId: string;
      tool: 'claude' | 'codex' | 'grok';
      company: string;
      project: string;
      title: string;
      startedAt: string;
    }
  | { kind: 'new'; company: string | null; project: string | null; channelId?: string };

export const NEW_SESSION_PREFIX = 'new?';
export const HISTORY_SESSION_PREFIX = 'history?';
export const SHARED_SESSION_PREFIX = 'shared?';

/** How restoring this extra-page param must reopen the session. Never start/send/fork. */
export type SessionRestorePath = 'none' | 'open' | 'openHistory' | 'shared-view';

export type SessionNavigateMode = 'push' | 'replace';

function clean(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

export function parseSessionsParam(param: string | null | undefined): SessionsRoute {
  const raw = param?.trim() ?? '';
  if (!raw) return { kind: 'empty' };
  if (raw.startsWith('shared?')) {
    const query = new URLSearchParams(raw.slice(7));
    const sessionId = clean(query.get('id'));
    const channelId = clean(query.get('channel'));
    return sessionId && channelId ? { kind: 'shared', sessionId, channelId } : { kind: 'empty' };
  }
  if (raw === 'new') return { kind: 'new', company: null, project: null };
  if (raw.startsWith(HISTORY_SESSION_PREFIX)) {
    const query = new URLSearchParams(raw.slice(HISTORY_SESSION_PREFIX.length));
    const sessionId = clean(query.get('id'));
    const rawTool = query.get('tool');
    const tool = rawTool === 'codex' || rawTool === 'grok' ? rawTool : 'claude';
    if (sessionId) {
      return {
        kind: 'history',
        sessionId,
        tool,
        company: clean(query.get('company')) ?? '',
        project: clean(query.get('project')) ?? '',
        title: clean(query.get('title')) ?? '',
        startedAt: clean(query.get('startedAt')) ?? '',
      };
    }
  }
  if (raw.startsWith(NEW_SESSION_PREFIX)) {
    const query = new URLSearchParams(raw.slice(NEW_SESSION_PREFIX.length));
    return {
      kind: 'new',
      company: clean(query.get('company')),
      project: clean(query.get('project')),
      ...(clean(query.get('channel')) ? { channelId: clean(query.get('channel'))! } : {}),
    };
  }
  return { kind: 'session', sessionId: raw };
}

export function sessionRestorePath(route: SessionsRoute): SessionRestorePath {
  switch (route.kind) {
    case 'shared':
      return 'shared-view';
    case 'history':
      return 'openHistory';
    case 'session':
      return 'open';
    case 'new':
    case 'empty':
      return 'none';
  }
}

export function isNewDraftRoute(route: SessionsRoute): boolean {
  return route.kind === 'new' || route.kind === 'empty';
}

/**
 * First successful send on a new draft replaces that draft identity so Back
 * cannot recreate the sent composer. Opening another session from a draft
 * (drawer, source, history) still pushes.
 */
export function sessionNavigateMode(options?: { replace?: boolean }): SessionNavigateMode {
  return options?.replace ? 'replace' : 'push';
}

/** Composer-draft persistence key. Null for live/history/shared (not unsent drafts). */
export function sessionDraftStorageKey(param: string | null | undefined): string | null {
  const route = parseSessionsParam(param);
  if (!isNewDraftRoute(route)) return null;
  const raw = param?.trim() ?? '';
  return `sessions:${raw || 'new'}`;
}

export function encodeHistorySessionParam(session: {
  id: string;
  tool: 'claude' | 'codex';
  company?: string;
  project?: string;
  title?: string;
  startedAt?: string;
}): string {
  const query = new URLSearchParams();
  query.set('id', session.id);
  query.set('tool', session.tool === 'codex' ? 'codex' : 'claude');
  if (session.company?.trim()) query.set('company', session.company.trim());
  if (session.project?.trim()) query.set('project', session.project.trim());
  if (session.title?.trim()) query.set('title', session.title.trim());
  if (session.startedAt?.trim()) query.set('startedAt', session.startedAt.trim());
  return `${HISTORY_SESSION_PREFIX}${query.toString()}`;
}

export function encodeSharedSessionParam(sessionId: string, channelId: string): string {
  return `${SHARED_SESSION_PREFIX}${new URLSearchParams({
    id: sessionId,
    channel: channelId,
  }).toString()}`;
}
