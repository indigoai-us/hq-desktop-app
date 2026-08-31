/**
 * Parse work-mesh session events posted as JSON chat messages.
 *
 * Work-mesh writes compact JSON into project channels (kind
 * `work-session-event`). The parser never throws: malformed bodies fall
 * through to `null` so the conversation can keep rendering the raw bubble.
 *
 * `payload` may be a plain object or an escaped JSON string, and may sit
 * at the top level or inside `event`.
 */

export type WorkSessionEventKind = 'claim' | 'start' | 'blocked' | 'done';

export interface WorkSessionActivity {
  kind: WorkSessionEventKind;
  actor: string;
  storyId: string | null;
  title: string | null;
  verb: string;
  at: string | null;
}

const VERB: Record<WorkSessionEventKind, string> = {
  claim: 'started',
  start: 'started',
  blocked: 'is blocked on',
  done: 'marked done',
};

function isKind(value: unknown): value is WorkSessionEventKind {
  return value === 'claim' || value === 'start' || value === 'blocked' || value === 'done';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** `payload` may already be an object, or a JSON string that parses to one. */
function asPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const parsed = parseJson(value);
    return isPlainObject(parsed) ? parsed : null;
  }
  return isPlainObject(value) ? value : null;
}

/** Suffix after the last `:`, e.g. `work-desktop-dogfood:T-002` → `T-002`. */
function storyIdFromThreadId(threadId: unknown): string | null {
  const raw = optionalString(threadId);
  if (!raw) return null;
  const colon = raw.lastIndexOf(':');
  if (colon === -1 || colon === raw.length - 1) return null;
  const suffix = raw.slice(colon + 1).trim();
  return suffix.length > 0 ? suffix : null;
}

export function parseWorkSessionEvent(body: string): WorkSessionActivity | null {
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return null;

  const parsed = parseJson(trimmed);
  if (!isPlainObject(parsed) || parsed.kind !== 'work-session-event') return null;

  const event = isPlainObject(parsed.event) ? parsed.event : null;
  if (!event || !isKind(event.kind)) return null;

  const payload = asPayload(parsed.payload) ?? asPayload(event.payload);
  const storyId = optionalString(payload?.storyId) ?? storyIdFromThreadId(parsed.threadId);
  const title = optionalString(payload?.storyTitle) ?? optionalString(event.summary);

  return {
    kind: event.kind,
    actor: optionalString(event.by) ?? 'Someone',
    storyId,
    title,
    verb: VERB[event.kind],
    at: optionalString(event.at),
  };
}
