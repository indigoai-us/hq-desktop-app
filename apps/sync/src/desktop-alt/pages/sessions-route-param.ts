// The Sessions page's opaque `extraPages` param, decoded.
//
// Two shapes: a session id (open that session), or `new?company=…&project=…`
// (a fresh chat pre-bound to a company and, optionally, a project — what the
// sidebar's "New session" action on a project channel navigates to). Anything
// else is treated as a session id, which is what the page always did.

export type SessionsRoute =
  | { kind: 'empty' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'new'; company: string | null; project: string | null };

export const NEW_SESSION_PREFIX = 'new?';

function clean(value: string | null): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

export function parseSessionsParam(param: string | null | undefined): SessionsRoute {
  const raw = param?.trim() ?? '';
  if (!raw) return { kind: 'empty' };
  if (raw === 'new') return { kind: 'new', company: null, project: null };
  if (raw.startsWith(NEW_SESSION_PREFIX)) {
    const query = new URLSearchParams(raw.slice(NEW_SESSION_PREFIX.length));
    return {
      kind: 'new',
      company: clean(query.get('company')),
      project: clean(query.get('project')),
    };
  }
  return { kind: 'session', sessionId: raw };
}
