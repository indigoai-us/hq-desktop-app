// Composer slash-command autocomplete — pure helpers.
//
// The composer merges TWO sources of commands: the `agent_session_slash_commands`
// probe (rich: description + argument hint, fetched once per page) and the
// `started` event's own catalog (whatever THIS session's CLI announced). They
// overlap heavily, so they are merged by name with the richer entry winning,
// and the result is filtered by whatever the user has typed after the '/'.
//
// PURE: no runes, no Tauri, no DOM — the whole autocomplete decision is a
// function of (draft, catalog), which is what makes it directly testable in
// the node-environment suite.

import type { SessionCommand } from './session-events';

/** A draft that is asking for command completion, and the prefix to match on. */
export interface SlashQuery {
  /** The text after the leading '/', lowercased. */
  prefix: string;
}

/**
 * Read a composer draft as a slash query.
 *
 * A draft completes commands only while it is still ONE `/name` token: the
 * moment a space is typed the user is writing arguments, and popping a list
 * over their arguments would be noise. Leading whitespace is tolerated;
 * anything else (including an empty draft) is not a query.
 */
export function slashQueryFor(draft: string): SlashQuery | null {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const token = trimmed.slice(1);
  if (/\s/.test(token)) return null;
  return { prefix: token.toLocaleLowerCase('en-US') };
}

/**
 * Merge two command catalogs by name. `primary` wins on collision — it is the
 * richer probe result — but a name only the session announced is still kept,
 * so a session-local command never disappears from the list.
 */
export function mergeSlashCommands(
  primary: ReadonlyArray<SessionCommand>,
  secondary: ReadonlyArray<SessionCommand>,
): SessionCommand[] {
  const byName = new Map<string, SessionCommand>();
  for (const command of secondary) byName.set(command.name, command);
  for (const command of primary) byName.set(command.name, command);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'en-US'));
}

/**
 * The commands to offer for `draft`, best match first.
 *
 * Returns `[]` for a draft that is not a slash query at all, so the caller's
 * "is the popup open?" test is simply "did this return anything?". Ranking:
 * a name that STARTS WITH the typed prefix outranks one that merely contains
 * it, and ties keep the merged catalog's (alphabetical) order.
 */
export function filterSlashCommands(
  draft: string,
  commands: ReadonlyArray<SessionCommand>,
  limit = 8,
): SessionCommand[] {
  const query = slashQueryFor(draft);
  if (!query) return [];
  const { prefix } = query;
  if (prefix.length === 0) return commands.slice(0, limit);

  const starts: SessionCommand[] = [];
  const contains: SessionCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLocaleLowerCase('en-US');
    if (name.startsWith(prefix)) starts.push(command);
    else if (name.includes(prefix)) contains.push(command);
  }
  return [...starts, ...contains].slice(0, limit);
}

/**
 * Apply a picked command to the draft: the whole `/name ` token is replaced,
 * with a trailing space so the user types arguments straight away. Any leading
 * whitespace the draft carried is preserved.
 */
export function applySlashCommand(draft: string, command: SessionCommand): string {
  const leading = draft.slice(0, draft.length - draft.trimStart().length);
  return `${leading}/${command.name} `;
}
