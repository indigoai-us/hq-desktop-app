/**
 * Shared recipient picker model. The list and chips UI was extracted from the
 * Forward picker (feat/dm-forward, US-009 revision) so New message, Forward,
 * and Share pick from the same grouped list: Recent, Channels, People, Bots.
 *
 * `RecipientItem` is a superset of `ForwardCandidate`, so ForwardPicker can
 * pass its candidates straight in. Every rule lives here so it is tested
 * without a DOM; RecipientPicker.svelte only renders and routes keys.
 */

export type RecipientKind = "person" | "bot" | "channel" | "group";
export type RecipientPickerMode = "message" | "forward" | "share";

export interface RecipientItem {
  /** `dm:<principalUid>` or `ch:<channelId>` (ForwardCandidate ids), or any stable id. */
  id: string;
  kind: RecipientKind;
  name: string;
  /** Null when the row is not company-scoped (plain DMs, group DMs). */
  companyUid: string | null;
  principalUid?: string;
  channelId?: string;
  /** Epoch-ms of the latest activity; 0 for roster-only contacts. Drives Recent. */
  lastActivityAt: number;
  /** Second line under the name: email for people, company for scoped rows. */
  subtitle?: string;
  /** Photo URL; people fall back to colored initials, bots to their mascot. */
  avatarUrl?: string | null;
  /** Presence dot outside the avatar. */
  online?: boolean;
  /** Right-side hint replacing the type tag: role, bot state, "12 members". */
  hint?: string | null;
  /** Every company the item is known in, for hosts that filter by scope. */
  companyUids?: readonly string[];
}

export interface RecipientScopeOption {
  /** "" is the host's default scope (e.g. "This conversation" or "Personal"). */
  id: string;
  label: string;
}

export interface RecipientQuote {
  authorName: string;
  authorId?: string | null;
  authorPhoto?: string | null;
  authorKind?: "person" | "bot";
  /** Short time label, e.g. "14:05". */
  time?: string | null;
  /** Where it came from, e.g. "in #welcome" or "Direct message". */
  origin?: string | null;
  body: string;
}

export type RecipientSectionKey = "recent" | "channels" | "people" | "bots";

export interface RecipientSection {
  key: RecipientSectionKey;
  label: string;
  items: RecipientItem[];
}

export const RECIPIENT_RECENT_LIMIT = 5;

const SECTION_LABEL: Record<RecipientSectionKey, string> = {
  recent: "Recent",
  channels: "Channels",
  people: "People",
  bots: "Bots",
};

export const RECIPIENT_KIND_LABEL: Record<RecipientKind, string> = {
  person: "Person",
  bot: "Bot",
  channel: "Channel",
  group: "Group",
};

/**
 * Match score (higher is better, 0 = no match): whole name 100, name prefix
 * 80, word prefix 60, subtitle prefix 50, name substring 30, subtitle
 * substring 20. A leading @ or # in the query is ignored.
 */
export function matchScore(item: RecipientItem, query: string): number {
  const q = query.trim().toLowerCase().replace(/^[@#]/, "");
  if (!q) return 1;
  const name = item.name.toLowerCase().replace(/^#/, "");
  const sub = (item.subtitle ?? "").toLowerCase().replace(/^@/, "");
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.split(/[\s._-]+/).some((word) => word.startsWith(q))) return 60;
  if (sub.startsWith(q)) return 50;
  if (name.includes(q)) return 30;
  if (sub.includes(q)) return 20;
  return 0;
}

const byRecency = (a: RecipientItem, b: RecipientItem): number =>
  b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name);

/** Items that match the query, best first; recency then name break ties. */
export function rankRecipients(items: readonly RecipientItem[], query: string): RecipientItem[] {
  return items
    .map((item) => ({ item, score: matchScore(item, query) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || byRecency(a.item, b.item))
    .map(({ item }) => item);
}

/**
 * Group items for the list. With no query the first section is the most
 * recently active destinations and those rows are not repeated below; the
 * rest are split by kind and sorted by recency. A query drops Recent and
 * ranks matches inside each section, so a destination never appears twice.
 */
export function groupRecipients(
  items: readonly RecipientItem[],
  query: string,
  recentLimit: number = RECIPIENT_RECENT_LIMIT,
): RecipientSection[] {
  const searching = query.trim().length > 0;
  const matches = searching ? rankRecipients(items, query) : [...items].sort(byRecency);
  const out: RecipientSection[] = [];
  const used = new Set<string>();
  if (!searching) {
    const recent = matches.filter((item) => item.lastActivityAt > 0).slice(0, recentLimit);
    if (recent.length > 0) {
      for (const item of recent) used.add(item.id);
      out.push({ key: "recent", label: SECTION_LABEL.recent, items: recent });
    }
  }
  const bucket = (key: RecipientSectionKey, pick: (item: RecipientItem) => boolean): void => {
    const picked = matches.filter((item) => !used.has(item.id) && pick(item));
    if (picked.length > 0) out.push({ key, label: SECTION_LABEL[key], items: picked });
  };
  bucket("channels", (item) => item.kind === "channel" || item.kind === "group");
  bucket("people", (item) => item.kind === "person");
  bucket("bots", (item) => item.kind === "bot");
  return out;
}

/** Flat order of the grouped list, for arrow-key navigation. */
export function flattenRecipientSections(sections: readonly RecipientSection[]): RecipientItem[] {
  return sections.flatMap((section) => section.items);
}

/** True when the item belongs to the scope ("" = every company). */
export function inRecipientScope(item: RecipientItem, scope: string): boolean {
  if (!scope) return true;
  const known = item.companyUids ?? (item.companyUid ? [item.companyUid] : []);
  return known.includes(scope);
}

/** Split text around the first case-insensitive match, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const q = query.trim().replace(/^[@#]/, "");
  if (!q) return [{ text, match: false }];
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [{ text, match: false }];
  return [
    { text: text.slice(0, at), match: false },
    { text: text.slice(at, at + q.length), match: true },
    { text: text.slice(at + q.length), match: false },
  ].filter((part) => part.text.length > 0);
}

/**
 * Toggle an id in the selection. Single-select replaces. With
 * `channelOpens` (New message: picking a channel opens it), a channel is a
 * whole conversation: it replaces people and bots, and a person or bot
 * drops a chosen channel. Forward and Share allow any mix.
 */
export function toggleRecipient(
  selectedIds: readonly string[],
  item: RecipientItem,
  options: { multiple: boolean; channelOpens?: boolean; items?: readonly RecipientItem[] },
): string[] {
  if (selectedIds.includes(item.id)) return selectedIds.filter((id) => id !== item.id);
  if (!options.multiple) return [item.id];
  if (!options.channelOpens) return [...selectedIds, item.id];
  const isChannel = (kind: RecipientKind) => kind === "channel" || kind === "group";
  if (isChannel(item.kind)) return [item.id];
  const kindOf = (id: string) => options.items?.find((candidate) => candidate.id === id)?.kind;
  return [...selectedIds.filter((id) => !isChannel(kindOf(id) ?? "person")), item.id];
}

/** Backspace in an empty search removes the last chip. */
export function removeLastRecipient(selectedIds: readonly string[]): string[] {
  return selectedIds.slice(0, -1);
}

/** Footer primary label by mode, with the count when more than one. */
export function recipientPrimaryLabel(mode: RecipientPickerMode, count: number): string {
  if (mode === "forward") return count > 1 ? `Forward to ${count}` : "Forward";
  if (mode === "share") return count > 1 ? `Share with ${count}` : "Share";
  return count > 1 ? `Start conversation with ${count}` : "Start conversation";
}

/** Search placeholder, by whether anyone is chosen yet. */
export function recipientPlaceholder(count: number): string {
  return count > 0 ? "Add another" : "Search people, bots, and channels";
}

/** Display name for a row or chip: channels carry a leading #. */
export function recipientDisplayName(item: Pick<RecipientItem, "kind" | "name">): string {
  return item.kind === "channel" && !item.name.startsWith("#") ? `#${item.name}` : item.name;
}

/** Next scope in the cycle (⌥←/⌥→ in the search switches scope). */
export function nextRecipientScope(
  scopes: readonly RecipientScopeOption[],
  current: string,
  step: 1 | -1 = 1,
): string {
  if (scopes.length === 0) return current;
  const at = scopes.findIndex((scope) => scope.id === current);
  return scopes[(at + step + scopes.length) % scopes.length]!.id;
}
