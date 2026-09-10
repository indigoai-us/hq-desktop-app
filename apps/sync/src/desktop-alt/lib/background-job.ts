import type { SessionEvent } from '../../components/sessions/session-events';

/** Fail a hidden generate-task session as soon as the CLI reports a hard error. */
export function backgroundJobFailure(events: ReadonlyArray<SessionEvent>): string | null {
  for (const event of events) {
    if (event.kind === 'error') {
      const message = (event.message ?? '').trim() || 'Session error';
      if (isAuthFailure(event.code, message)) {
        return 'Authentication failed — sign in to the provider again.';
      }
      return message;
    }
    if (event.kind === 'turnDone' && event.status === 'error') {
      const message = (event.error ?? '').trim();
      if (isAuthFailure(null, message)) {
        return 'Authentication failed — sign in to the provider again.';
      }
      if (message) return message;
    }
    if (event.kind === 'exited' && typeof event.code === 'number' && event.code !== 0) {
      return `Session exited (${event.code}).`;
    }
  }
  return null;
}

function isAuthFailure(code: string | null | undefined, text: string): boolean {
  if (code === 'authentication_failed') return true;
  return /authenticate|oauth|revoked|sign in/i.test(text);
}
