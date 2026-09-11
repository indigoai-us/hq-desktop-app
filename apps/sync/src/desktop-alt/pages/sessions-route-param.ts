// The Sessions page's opaque `extraPages` param, decoded.
//
// Two shapes: a session id (open that session), or `new?company=…&project=…`
// (a fresh chat pre-bound to a company and, optionally, a project — what the
// sidebar's "New session" action on a project channel navigates to). Anything
// else is treated as a session id, which is what the page always did.

export type SessionsRoute =
  | { kind: 'shared'; sessionId: string; channelId: string }
  | { kind: 'empty' }
  | { kind: 'session'; sessionId: string; company?: string | null }
  | {
      kind: 'history';
      sessionId: string;
      tool: 'claude' | 'codex' | 'grok';
      company: string;
      project: string;
      title: string;
      startedAt: string;
    }
  | {
      kind: 'new';
      company: string | null;
      project: string | null;
      channelId?: string;
      /**
       * Text the page should send on the person's behalf as soon as the
       * session can start (#welcome's Run Setup carries `/setup`). Absent for
       * an ordinary "New session".
       */
      prompt?: string;
      /**
       * Text seeded into the composer and left there for the person to send
       * (#welcome's "Continue in HQ Sessions" carries `/startwork <company>`).
       * Unlike `prompt`, nothing is sent on their behalf.
       */
      prefill?: string;
    };

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
      ...(clean(query.get('prompt')) ? { prompt: clean(query.get('prompt'))! } : {}),
      ...(clean(query.get('prefill')) ? { prefill: clean(query.get('prefill'))! } : {}),
    };
  }
  const queryAt = raw.indexOf('?');
  if (queryAt > 0) {
    const sessionId = raw.slice(0, queryAt).trim();
    const company = clean(new URLSearchParams(raw.slice(queryAt + 1)).get('company'));
    if (sessionId) {
      return {
        kind: 'session',
        sessionId,
        ...(company ? { company } : {}),
      };
    }
  }
  return { kind: 'session', sessionId: raw };
}

/** The #welcome "Continue in HQ Sessions" destination: a fresh session with `text` waiting in the composer, unsent. */
export function prefilledSessionParam(text: string): string {
  const query = new URLSearchParams({ draft: crypto.randomUUID(), prefill: text });
  return `${NEW_SESSION_PREFIX}${query.toString()}`;
}

/** The #welcome "Run Setup" destination: a fresh session that sends `prompt` itself. */
export function setupSessionParam(prompt: string): string {
  const query = new URLSearchParams({ draft: crypto.randomUUID(), prompt });
  return `${NEW_SESSION_PREFIX}${query.toString()}`;
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
  tool: 'claude' | 'codex' | 'grok';
  company?: string;
  project?: string;
  title?: string;
  startedAt?: string;
}): string {
  const query = new URLSearchParams();
  query.set('id', session.id);
  query.set(
    'tool',
    session.tool === 'codex' ? 'codex' : session.tool === 'grok' ? 'grok' : 'claude',
  );
  if (session.company?.trim()) query.set('company', session.company.trim());
  if (session.project?.trim()) query.set('project', session.project.trim());
  if (session.title?.trim()) query.set('title', session.title.trim());
  if (session.startedAt?.trim()) query.set('startedAt', session.startedAt.trim());
  return `${HISTORY_SESSION_PREFIX}${query.toString()}`;
}

export function encodeSharedSessionParam(
  sessionId: string,
  channelId: string,
  company?: string | null,
): string {
  const query = new URLSearchParams({
    id: sessionId,
    channel: channelId,
  });
  if (company?.trim()) query.set('company', company.trim());
  return `${SHARED_SESSION_PREFIX}${query.toString()}`;
}

/** Live app-owned session extra param. `?company=` is how the shell ACL keys it. */
export function encodeLiveSessionParam(
  sessionId: string,
  company?: string | null,
): string {
  const id = sessionId.trim();
  const key = company?.trim() ?? '';
  if (!id) return sessionId;
  if (!key) return id;
  return `${id}?${new URLSearchParams({ company: key }).toString()}`;
}
