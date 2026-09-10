import type { SessionEvent } from '../../components/sessions/session-events';

export const GENERATE_TASK_TIMEOUT_MS = 10 * 60 * 1000;
/** Extra Board polls after the CLI vanishes, then fail instead of waiting out the cap. */
export const GENERATE_TASK_SETTLE_MS = 20 * 1000;

export type GeneratedStoryDraft = {
  id: string;
  title: string;
  description: string;
  status: string;
  passes: boolean;
};

export function createdStoryTitle(
  knownIds: ReadonlySet<string>,
  stories: ReadonlyArray<{ id?: string; title?: string }>,
): string | null {
  const created = stories.find((story) => story.id && !knownIds.has(story.id) && story.title?.trim());
  return created?.title?.trim() ?? null;
}

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

/** Pull a Board-ready story out of the hidden job's streamed text, if any. */
export function parseGeneratedStoryFromEvents(
  events: ReadonlyArray<SessionEvent>,
): GeneratedStoryDraft | null {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.kind === 'textDelta' || event.kind === 'assistantMessage') {
      const text = event.text?.trim();
      if (text) chunks.push(text);
    }
  }
  const blob = chunks.join('\n');
  const fenced = blob.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], blob];
  for (const raw of candidates) {
    const parsed = parseStoryJson(raw);
    if (parsed) return parsed;
  }
  return null;
}

function parseStoryJson(raw: string | undefined): GeneratedStoryDraft | null {
  if (!raw?.trim()) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const title = typeof value.title === 'string' ? value.title.trim() : '';
    if (!title) return null;
    const id =
      typeof value.id === 'string' && value.id.trim() ? value.id.trim() : `US-${Date.now()}`;
    const criteria = Array.isArray(value.acceptanceCriteria)
      ? value.acceptanceCriteria
          .map((row) =>
            typeof row === 'string'
              ? row
              : row && typeof row === 'object' && 'text' in row && typeof row.text === 'string'
                ? row.text
                : '',
          )
          .filter(Boolean)
      : [];
    const description = [
      typeof value.description === 'string' ? value.description.trim() : '',
      criteria.length ? `Acceptance:\n${criteria.map((c) => `- ${c}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      id,
      title,
      description,
      status: typeof value.status === 'string' && value.status.trim() ? value.status.trim() : 'todo',
      passes: false,
    };
  } catch {
    return null;
  }
}
