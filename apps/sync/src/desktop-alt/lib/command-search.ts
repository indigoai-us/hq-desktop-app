export interface SearchableCommand {
  label: string;
  detail: string;
  shortcut?: string;
  keywords?: string[];
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Rank a command the way a human expects a launcher to work: exact and prefix
 * matches first, then word/substring matches, with loose subsequences last.
 * `null` means no match. Lower scores are better.
 */
export function scoreCommandMatch(command: SearchableCommand, query: string): number | null {
  const needle = normalized(query);
  if (!needle) return 0;

  const label = normalized(command.label);
  const detail = normalized(command.detail);
  const shortcut = normalized(command.shortcut ?? '');
  const keywords = command.keywords?.map(normalized).join(' ') ?? '';
  const haystack = `${label} ${detail} ${shortcut} ${keywords}`;

  if (label === needle) return 0;
  if (label.startsWith(needle)) return 10 + Math.min(20, label.length - needle.length);

  const wordIndex = label.split(/\s+/).findIndex((word) => word.startsWith(needle));
  if (wordIndex >= 0) return 30 + wordIndex;

  const labelIndex = label.indexOf(needle);
  if (labelIndex >= 0) return 50 + labelIndex;

  const broadIndex = haystack.indexOf(needle);
  if (broadIndex >= 0) return 80 + Math.min(40, broadIndex);

  let cursor = 0;
  let gapPenalty = 0;
  for (const character of needle) {
    const foundAt = haystack.indexOf(character, cursor);
    if (foundAt === -1) return null;
    gapPenalty += foundAt - cursor;
    cursor = foundAt + 1;
  }

  return 140 + Math.min(100, gapPenalty);
}

export function rankCommands<T extends SearchableCommand>(commands: T[], query: string): T[] {
  return commands
    .map((command, index) => ({ command, index, score: scoreCommandMatch(command, query) }))
    .filter((entry): entry is typeof entry & { score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
}
