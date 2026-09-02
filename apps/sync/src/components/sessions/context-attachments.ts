// Context attachments — the `+` menu's meetings, signals, vault files and
// pasted paths, from the chip under the textarea to the block on the wire.
//
// A pick becomes a chip; a chip is loaded (`hq_reference_text`, 6 000 chars)
// the moment it lands so the composer can show the running size honestly; on
// send every loaded chip is appended AFTER the user's text as one
// `<hq-context …>` block. The transcript never shows that block: the bubble
// shows the user's words plus small "Attached: Meeting · title" tags, which
// `splitContextBlocks` recovers from a backend-recorded turn, so a replayed
// transcript reads the same as a live one.
//
// PURE. The one `invoke` for reading text lives in the store; every loader the
// menu needs is passed in as a function.

/** Where a chip came from — the `source` attribute on the wire. */
export type ContextSource = 'meeting' | 'signal' | 'vault' | 'path';

/** A pick from the `+` menu, before its text is read. */
export interface ContextAttachment {
  kind: ContextSource;
  /** What the chip says: a meeting title, a signal title, a file name. */
  title: string;
  /** Absolute path (the backend readers return absolutes). */
  path: string;
  /** A date or a kind, when the chip has one. */
  subtitle?: string;
}

/** A chip whose text has been read. */
export interface LoadedAttachment extends ContextAttachment {
  text: string;
  truncated: boolean;
}

/** What rides a mirrored user turn so the bubble can render its tags. */
export interface TurnAttachment {
  kind: ContextSource;
  title: string;
  path: string;
}

/** `hq_recent_meetings` row. */
export interface MeetingEntry {
  id: string;
  title: string;
  date: string | null;
  path: string;
  participants: string[];
  summary: string;
}

/** `hq_signals` row. */
export interface SignalEntry {
  id: string;
  kind: string;
  title: string;
  date: string | null;
  path: string;
  snippet: string;
}

/** `hq_vault_files` row. */
export interface VaultEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  bytes: number;
  modifiedAt: string | null;
}

/** `hq_reference_text` result. */
export interface ReferenceText {
  path: string;
  text: string;
  truncated: boolean;
}

/** The functions the `+` menu needs — the store provides the Tauri-backed set. */
export interface ContextLoaders {
  meetings: (company: string) => Promise<MeetingEntry[]>;
  signals: (company: string) => Promise<SignalEntry[]>;
  vaultFiles: (company: string, prefix: string, query: string) => Promise<VaultEntry[]>;
  referenceText: (path: string, maxChars: number) => Promise<ReferenceText>;
}

/** At most this many chips on one message. */
export const MAX_ATTACHMENTS = 4;
/** At most this many characters of attached text on one message. */
export const MAX_CONTEXT_CHARS = 24_000;
/** How much of each file is read. */
export const ATTACHMENT_CHARS = 6_000;

const SOURCE_LABEL: Record<ContextSource, string> = {
  meeting: 'Meeting',
  signal: 'Signal',
  vault: 'File',
  path: 'Path',
};

export function sourceLabel(kind: ContextSource): string {
  return SOURCE_LABEL[kind];
}

/** "Meeting · Weekly sync · 2026-09-01" — the chip and the transcript tag. */
export function attachmentLabel(attachment: TurnAttachment & { subtitle?: string }): string {
  const parts = [sourceLabel(attachment.kind), attachment.title];
  if (attachment.subtitle) parts.push(attachment.subtitle);
  return parts.join(' · ');
}

/** `2026-09-01T14:00:00Z` → `2026-09-01`; anything else verbatim. */
export function shortDate(value: string | null | undefined): string {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : value;
}

/** A signal kind on the wire (`action_item`) as a heading ("Action items"). */
export function signalKindLabel(kind: string): string {
  const words = kind.replace(/[_-]+/g, ' ').trim();
  if (!words) return 'Other';
  const sentence = words.charAt(0).toLocaleUpperCase('en-US') + words.slice(1);
  return /^(decision|question|risk|commitment|summary|key point|action item)$/i.test(words)
    ? `${sentence}s`
    : sentence;
}

export function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The chip a meeting row becomes. */
export function attachmentFromMeeting(meeting: MeetingEntry): ContextAttachment {
  return {
    kind: 'meeting',
    title: meeting.title || basenameOf(meeting.path),
    path: meeting.path,
    subtitle: shortDate(meeting.date) || undefined,
  };
}

export function attachmentFromSignal(signal: SignalEntry): ContextAttachment {
  return {
    kind: 'signal',
    title: signal.title || basenameOf(signal.path),
    path: signal.path,
    subtitle: signalKindLabel(signal.kind).replace(/s$/, '').toLocaleLowerCase('en-US'),
  };
}

export function attachmentFromVault(entry: VaultEntry): ContextAttachment {
  return { kind: 'vault', title: entry.name, path: entry.path };
}

export function attachmentFromPath(path: string): ContextAttachment {
  const trimmed = path.trim();
  return { kind: 'path', title: basenameOf(trimmed), path: trimmed };
}

/**
 * Add a chip, or say why not: a duplicate path is a no-op, and the cap is
 * enforced HERE so every entry point (menu, paste) shares one rule.
 */
export function addAttachment<T extends ContextAttachment>(
  list: ReadonlyArray<T>,
  attachment: T,
): { list: T[]; error: string | null } {
  if (list.some((entry) => entry.path === attachment.path)) {
    return { list: [...list], error: null };
  }
  if (list.length >= MAX_ATTACHMENTS) {
    return { list: [...list], error: `At most ${MAX_ATTACHMENTS} attachments per message.` };
  }
  return { list: [...list, attachment], error: null };
}

export function removeAttachment<T extends ContextAttachment>(
  list: ReadonlyArray<T>,
  path: string,
): T[] {
  return list.filter((entry) => entry.path !== path);
}

/** The characters of attached TEXT across every loaded chip. */
export function contextChars(list: ReadonlyArray<Partial<LoadedAttachment>>): number {
  return list.reduce((sum, entry) => sum + (entry.text?.length ?? 0), 0);
}

/** The running size, as the composer shows it: "2 of 4 · 8.4k / 24k chars". */
export function contextSizeLabel(list: ReadonlyArray<Partial<LoadedAttachment>>): string {
  return `${list.length} of ${MAX_ATTACHMENTS} · ${compactChars(contextChars(list))} / ${compactChars(MAX_CONTEXT_CHARS)} chars`;
}

export function compactChars(value: number): string {
  if (value < 1000) return String(value);
  const k = value / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

/** Would adding `text` push the message over the character budget? */
export function exceedsContextBudget(
  list: ReadonlyArray<Partial<LoadedAttachment>>,
  text: string,
): boolean {
  return contextChars(list) + text.length > MAX_CONTEXT_CHARS;
}

// ---------------------------------------------------------------------------
// The wire format
// ---------------------------------------------------------------------------

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** `/Users/x/HQ/companies/indigo/a.md` → `companies/indigo/a.md`. */
export function hqRelativePath(path: string, hqRoot: string): string {
  const root = hqRoot.replace(/[\\/]+$/, '');
  if (root && (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`))) {
    return path.slice(root.length + 1);
  }
  return path;
}

/**
 * One attachment as the CLI receives it:
 *
 *   <hq-context source="meeting" path="companies/indigo/sources/meetings/x.md" title="Weekly sync">
 *   …text…
 *   (truncated)
 *   </hq-context>
 *
 * `path` is HQ-relative when `hqRoot` is known, so the block reads the same on
 * every machine and the agent can open it from the HQ root.
 */
export function formatContextBlock(attachment: LoadedAttachment, hqRoot = ''): string {
  const path = hqRelativePath(attachment.path, hqRoot);
  const open = `<hq-context source="${attachment.kind}" path="${escapeAttribute(path)}" title="${escapeAttribute(attachment.title)}">`;
  const body = attachment.text.replace(/\s+$/, '');
  const note = attachment.truncated ? '\n(truncated)' : '';
  return `${open}\n${body}${note}\n</hq-context>`;
}

/** The message on the wire: the user's text, then every block, in order. */
export function composeWithContext(
  text: string,
  attachments: ReadonlyArray<LoadedAttachment>,
  hqRoot = '',
): string {
  if (attachments.length === 0) return text;
  const blocks = attachments.map((attachment) => formatContextBlock(attachment, hqRoot));
  return `${text.replace(/\s+$/, '')}\n\n${blocks.join('\n')}`;
}

const BLOCK = /<hq-context\b([^>]*)>[\s\S]*?<\/hq-context>/g;
const ATTRIBUTE = /(\w[\w-]*)="([^"]*)"/g;

function readAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of raw.matchAll(ATTRIBUTE)) {
    out[match[1]!] = unescapeAttribute(match[2]!);
  }
  return out;
}

const SOURCES = new Set<string>(['meeting', 'signal', 'vault', 'path']);

/**
 * Take the context blocks OUT of a recorded turn: the words the user typed,
 * plus one tag per block. This is what the transcript renders for a backend
 * `userMessage`, so the raw block is never a bubble.
 */
export function splitContextBlocks(text: string): { text: string; attachments: TurnAttachment[] } {
  const attachments: TurnAttachment[] = [];
  const stripped = text.replace(BLOCK, (_whole, raw: string) => {
    const attributes = readAttributes(raw);
    const source = attributes.source ?? 'path';
    const kind = (SOURCES.has(source) ? source : 'path') as ContextSource;
    const path = attributes.path ?? '';
    attachments.push({ kind, title: attributes.title || basenameOf(path) || 'context', path });
    return '';
  });
  return { text: stripped.replace(/\s+$/, ''), attachments };
}
