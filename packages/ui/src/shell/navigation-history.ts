/**
 * In-app navigation history for the shared desktop shell.
 *
 * Destinations are serializable data (stable IDs + params + account/company
 * scope). This is not `window.history`, not a web router, and not the
 * pending-route bridge in `embedded-navigation.ts`.
 */

import type {
  EmbeddedNavigationTarget,
  EmbeddedSettingsSection,
} from "./embedded-navigation.js";
import { EMBEDDED_SETTINGS_SECTIONS } from "./embedded-navigation.js";
import type { LibraryTab } from "../library/library-overlay-model.js";
import type { CompanyChannelTabId } from "../chat/tabs/tab-model.js";

export const NAVIGATION_HISTORY_CAP = 100;

export type ChannelSurfaceTab = "chat" | "board" | "files";
export type AgentSurfaceTab = "chat" | "details";

export interface NavigationScope {
  accountId: string;
  companyUid: string | null;
}

/** Per-entry scroll. Prefer a stable identity; pixel offset is the fallback. */
export type NavigationScrollAnchorKind = "message" | "event" | "file" | "pixel";

export interface NavigationScrollState {
  kind: NavigationScrollAnchorKind;
  /** Message, event, or file identity. Null only for pixel fallback. */
  id: string | null;
  offset: number;
}

/**
 * Discriminated destination union. Values must stay JSON-serializable:
 * no component instances, adapter handles, presigned URLs, cached
 * content/titles, or promises.
 */
export type NavigationDestination =
  | { kind: "messages" }
  | {
      kind: "channel";
      channelId: string;
      replyRootEventId?: string | null;
      tab?: ChannelSurfaceTab;
      companyTab?: CompanyChannelTabId;
      agentSurface?: AgentSurfaceTab;
      fileKey?: string | null;
    }
  | {
      kind: "dm";
      personUid: string;
      replyRootEventId?: string | null;
      agentSurface?: AgentSurfaceTab;
    }
  | { kind: "notifications" }
  | { kind: "meetings"; meetingId?: string | null }
  | { kind: "atlas" }
  | { kind: "library"; tab: LibraryTab; itemId?: string | null }
  | { kind: "settings"; section?: EmbeddedSettingsSection | null }
  | { kind: "shared-files" }
  | {
      kind: "extra";
      page: string;
      param?: string | null;
      /** Membership uid or slug when the extra page is company-scoped. */
      companyUid?: string | null;
    }
  | { kind: "setup-checkout"; companyUid: string; checkout?: string | null };

export interface NavigationEntry {
  destination: NavigationDestination;
  accountId: string;
  companyUid: string | null;
  scroll?: NavigationScrollState | null;
}

export type NonNavigationReason =
  | "hydration"
  | "polling"
  | "live-session-phase"
  | "background-roster"
  | "cosmetic-sidebar";

export type NavigationCommit =
  | { kind: "navigate"; mode: "push" | "replace"; entry: NavigationEntry }
  | { kind: "non-navigation"; reason: NonNavigationReason };

export interface NavigationHistorySnapshot {
  entries: readonly NavigationEntry[];
  index: number;
}

export interface NavigationHistory {
  snapshot(): NavigationHistorySnapshot;
  current(): NavigationEntry | null;
  canGoBack(): boolean;
  canGoForward(): boolean;
  push(entry: NavigationEntry): NavigationHistorySnapshot;
  replace(entry: NavigationEntry): NavigationHistorySnapshot;
  back(): NavigationEntry | null;
  forward(): NavigationEntry | null;
  recordScroll(scroll: NavigationScrollState | null): NavigationHistorySnapshot;
  filter(keep: (entry: NavigationEntry) => boolean): NavigationHistorySnapshot;
  clear(): void;
}

/** Neighbor used by title-bar hover labels. Does not move the cursor. */
export function historyNeighbor(
  snapshot: NavigationHistorySnapshot,
  direction: "back" | "forward",
): NavigationEntry | null {
  const index =
    direction === "back" ? snapshot.index - 1 : snapshot.index + 1;
  if (index < 0 || index >= snapshot.entries.length) return null;
  return snapshot.entries[index] ?? null;
}

const CHANNEL_TABS = new Set<ChannelSurfaceTab>(["chat", "board", "files"]);
const AGENT_SURFACES = new Set<AgentSurfaceTab>(["chat", "details"]);
const COMPANY_TABS = new Set<CompanyChannelTabId>([
  "chat",
  "atlas",
  "team",
  "settings",
]);
const LIBRARY_TABS = new Set<LibraryTab>([
  "skills",
  "workers",
  "installed",
  "marketplace",
  "submit",
  "profile",
]);
// Derived from the single source of truth so a new section (e.g. "bots",
// local-bots US-009) cannot be silently dropped from history canonicalisation
// — a hand-copied list here reset Settings → Bots to Profile on every click.
const SETTINGS_SECTIONS = new Set<EmbeddedSettingsSection>(EMBEDDED_SETTINGS_SECTIONS);

const FORBIDDEN_ENTRY_KEYS = new Set([
  "component",
  "adapter",
  "handle",
  "promise",
  "previewUrl",
  "presignedUrl",
  "cachedContent",
  "bytes",
  "blob",
]);

const SCROLL_KINDS = new Set<NavigationScrollAnchorKind>([
  "message",
  "event",
  "file",
  "pixel",
]);

function trimId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const next = value.trim();
  return next ? next : null;
}

function requireId(value: string, label: string): string {
  const next = trimId(value);
  if (!next) {
    throw new Error(`Navigation destination missing ${label}`);
  }
  return next;
}

function asChannelTab(value: ChannelSurfaceTab | undefined): ChannelSurfaceTab {
  return value && CHANNEL_TABS.has(value) ? value : "chat";
}

function asAgentSurface(
  value: AgentSurfaceTab | undefined,
): AgentSurfaceTab {
  return value && AGENT_SURFACES.has(value) ? value : "chat";
}

function asCompanyTab(
  value: CompanyChannelTabId | undefined,
): CompanyChannelTabId {
  return value && COMPANY_TABS.has(value) ? value : "chat";
}

function asLibraryTab(value: LibraryTab | undefined): LibraryTab {
  return value && LIBRARY_TABS.has(value) ? value : "skills";
}

function asSettingsSection(
  value: EmbeddedSettingsSection | null | undefined,
): EmbeddedSettingsSection | null {
  if (value == null) return null;
  return SETTINGS_SECTIONS.has(value) ? value : null;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainJsonValue(value: unknown): boolean {
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "number" || kind === "boolean") return true;
  if (kind !== "object") return false;
  if (Array.isArray(value)) return value.every(isPlainJsonValue);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) => !FORBIDDEN_ENTRY_KEYS.has(key) && isPlainJsonValue(nested),
  );
}

/** Runtime guard: history entries must be JSON data, never live objects. */
export function assertSerializableNavigationEntry(entry: NavigationEntry): void {
  if (!isPlainJsonValue(entry)) {
    throw new Error("Navigation history entry is not serializable JSON data");
  }
  const json = JSON.stringify(entry);
  if (/X-Amz-|presign|Signature=/i.test(json)) {
    throw new Error("Navigation history must not store presigned URLs");
  }
  const roundTrip = JSON.parse(json) as NavigationEntry;
  if (canonicalEntryKey(roundTrip) !== canonicalEntryKey(entry)) {
    throw new Error("Navigation history entry did not round-trip through JSON");
  }
}

export function canonicalizeDestination(
  destination: NavigationDestination,
): NavigationDestination {
  switch (destination.kind) {
    case "messages":
    case "notifications":
    case "atlas":
    case "shared-files":
      return { kind: destination.kind };
    case "channel": {
      const tab = asChannelTab(destination.tab);
      return {
        kind: "channel",
        channelId: requireId(destination.channelId, "channelId"),
        replyRootEventId: trimId(destination.replyRootEventId),
        tab,
        companyTab: asCompanyTab(destination.companyTab),
        agentSurface: asAgentSurface(destination.agentSurface),
        fileKey: tab === "files" ? trimId(destination.fileKey) : null,
      };
    }
    case "dm":
      return {
        kind: "dm",
        personUid: requireId(destination.personUid, "personUid"),
        replyRootEventId: trimId(destination.replyRootEventId),
        agentSurface: asAgentSurface(destination.agentSurface),
      };
    case "meetings":
      return {
        kind: "meetings",
        meetingId: trimId(destination.meetingId),
      };
    case "library":
      return {
        kind: "library",
        tab: asLibraryTab(destination.tab),
        itemId: trimId(destination.itemId),
      };
    case "settings":
      return {
        kind: "settings",
        section: asSettingsSection(destination.section),
      };
    case "extra": {
      const companyUid =
        trimId(destination.companyUid) ?? extraParamCompanyKey(destination.param);
      return {
        kind: "extra",
        page: requireId(destination.page, "page"),
        param: trimId(destination.param),
        ...(companyUid ? { companyUid } : {}),
      };
    }
    case "setup-checkout":
      return {
        kind: "setup-checkout",
        companyUid: requireId(destination.companyUid, "companyUid"),
        checkout: trimId(destination.checkout),
      };
  }
}

export function canonicalizeScroll(
  scroll: NavigationScrollState | null | undefined,
): NavigationScrollState | null {
  if (!scroll) return null;
  const kind = SCROLL_KINDS.has(scroll.kind) ? scroll.kind : "pixel";
  const id = kind === "pixel" ? null : trimId(scroll.id);
  const offset = Number.isFinite(scroll.offset)
    ? Math.max(0, Math.round(scroll.offset))
    : 0;
  if (kind !== "pixel" && !id) {
    return { kind: "pixel", id: null, offset };
  }
  return { kind, id, offset };
}

export function canonicalizeEntry(entry: NavigationEntry): NavigationEntry {
  const accountId = requireId(entry.accountId, "accountId");
  return {
    destination: canonicalizeDestination(entry.destination),
    accountId,
    companyUid: trimId(entry.companyUid),
    scroll: canonicalizeScroll(entry.scroll),
  };
}

export function canonicalDestinationKey(
  destination: NavigationDestination,
): string {
  const dest = canonicalizeDestination(destination);
  switch (dest.kind) {
    case "messages":
    case "notifications":
    case "atlas":
    case "shared-files":
      return dest.kind;
    case "channel":
      return [
        "channel",
        dest.channelId,
        dest.replyRootEventId ?? "",
        dest.tab,
        dest.companyTab,
        dest.agentSurface,
        dest.fileKey ?? "",
      ].join(":");
    case "dm":
      return [
        "dm",
        dest.personUid,
        dest.replyRootEventId ?? "",
        dest.agentSurface,
      ].join(":");
    case "meetings":
      return `meetings:${dest.meetingId ?? ""}`;
    case "library":
      return `library:${dest.tab}:${dest.itemId ?? ""}`;
    case "settings":
      return `settings:${dest.section ?? ""}`;
    case "extra":
      return `extra:${dest.page}:${dest.param ?? ""}:${dest.companyUid ?? ""}`;
    case "setup-checkout":
      return `setup-checkout:${dest.companyUid}:${dest.checkout ?? ""}`;
  }
}

export function canonicalEntryKey(entry: NavigationEntry): string {
  const next = canonicalizeEntry(entry);
  return `${next.accountId}|${next.companyUid ?? ""}|${canonicalDestinationKey(next.destination)}`;
}

export function destinationsEqual(
  a: NavigationDestination,
  b: NavigationDestination,
): boolean {
  return canonicalDestinationKey(a) === canonicalDestinationKey(b);
}

export function entriesEqual(a: NavigationEntry, b: NavigationEntry): boolean {
  return canonicalEntryKey(a) === canonicalEntryKey(b);
}

/** Nav labels that differ from the section id (owner vocabulary, 2026-09-11). */
function settingsSectionLabel(section: string): string {
  if (section === "agents") return "AI tools";
  return titleCase(section);
}

function titleCase(value: string): string {
  if (!value) return value;
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function extraPageLabel(page: string, param: string | null): string {
  if (page !== "sessions") return titleCase(page.replace(/[-_]/g, " "));
  if (!param) return "Sessions";
  if (param === "new" || param.startsWith("new?")) return "New session";
  if (param.startsWith("shared?")) return "Shared session";
  if (param.startsWith("history?")) return "Session";
  return "Session";
}

export function destinationLabel(destination: NavigationDestination): string {
  const dest = canonicalizeDestination(destination);
  switch (dest.kind) {
    case "messages":
      return "Messages";
    case "channel":
      if (dest.replyRootEventId) return "Thread";
      if (dest.tab === "board") return "Board";
      if (dest.tab === "files") return dest.fileKey ? "File preview" : "Files";
      if (dest.companyTab && dest.companyTab !== "chat") {
        return `Company · ${titleCase(dest.companyTab)}`;
      }
      if (dest.agentSurface === "details") return "Bot details";
      return "Channel";
    case "dm":
      if (dest.replyRootEventId) return "Thread";
      if (dest.agentSurface === "details") return "Bot details";
      return "Direct message";
    case "notifications":
      return "Notifications";
    case "meetings":
      return dest.meetingId ? "Meeting" : "Meetings";
    case "atlas":
      return "Atlas";
    case "library":
      return `Library · ${titleCase(dest.tab)}`;
    case "settings":
      return dest.section ? `Settings · ${settingsSectionLabel(dest.section)}` : "Settings";
    case "shared-files":
      return "Shared files";
    case "extra":
      return extraPageLabel(dest.page, dest.param ?? null);
    case "setup-checkout":
      return "Setup";
  }
}

export function createNavigationEntry(
  destination: NavigationDestination,
  scope: NavigationScope,
  scroll?: NavigationScrollState | null,
): NavigationEntry {
  const entry = canonicalizeEntry({
    destination,
    accountId: scope.accountId,
    companyUid: scope.companyUid,
    scroll: scroll ?? null,
  });
  assertSerializableNavigationEntry(entry);
  return entry;
}

/** Keep destinations whose company is still in the signed-in membership. */
export function extraParamCompanyKey(
  param: string | null | undefined,
): string | null {
  const raw = param?.trim() ?? "";
  const q = raw.indexOf("?");
  if (q < 0) return null;
  try {
    return trimId(new URLSearchParams(raw.slice(q + 1)).get("company"));
  } catch {
    return null;
  }
}

/** Sessions extras that restore a specific session must carry a company key. */
export function sessionExtraRequiresCompany(
  param: string | null | undefined,
): boolean {
  const raw = param?.trim() ?? "";
  if (!raw || raw === "new" || raw.startsWith("new?")) return false;
  return true;
}

export function destinationCompanyKey(
  destination: NavigationDestination,
): string | null {
  if (destination.kind === "setup-checkout") {
    return trimId(destination.companyUid);
  }
  if (destination.kind === "extra") {
    return (
      trimId(destination.companyUid) ?? extraParamCompanyKey(destination.param)
    );
  }
  return null;
}

export function entryCompanyIsAccessible(
  entry: NavigationEntry,
  accessibleCompanyUids: ReadonlySet<string> | null,
): boolean {
  if (!accessibleCompanyUids) return true;
  const uid =
    trimId(entry.companyUid) ?? destinationCompanyKey(entry.destination);
  if (!uid) return true;
  return accessibleCompanyUids.has(uid);
}

function freezeSnapshot(
  entries: NavigationEntry[],
  index: number,
): NavigationHistorySnapshot {
  return {
    entries: entries.map((entry) => cloneJson(entry)),
    index,
  };
}

export function createNavigationHistory(
  cap = NAVIGATION_HISTORY_CAP,
): NavigationHistory {
  const limit = Math.max(1, cap);
  let entries: NavigationEntry[] = [];
  let index = -1;

  const snapshot = (): NavigationHistorySnapshot =>
    freezeSnapshot(entries, index);

  const current = (): NavigationEntry | null =>
    index >= 0 ? cloneJson(entries[index]!) : null;

  const commit = (entry: NavigationEntry, mode: "push" | "replace") => {
    const next = createNavigationEntry(
      entry.destination,
      {
        accountId: entry.accountId,
        companyUid: entry.companyUid,
      },
      entry.scroll,
    );
    const at = index >= 0 ? entries[index]! : null;
    if (mode === "push" && at && entriesEqual(at, next)) {
      return snapshot();
    }
    if (mode === "replace" && at && entriesEqual(at, next)) {
      return snapshot();
    }
    if (index >= 0 && entries[index]!.accountId !== next.accountId) {
      entries = [next];
      index = 0;
      return snapshot();
    }
    if (mode === "replace" && index >= 0) {
      entries = [...entries.slice(0, index), next];
      index = entries.length - 1;
      return snapshot();
    }
    entries = [...entries.slice(0, index + 1), next];
    index = entries.length - 1;
    if (entries.length > limit) {
      const overflow = entries.length - limit;
      entries = entries.slice(overflow);
      index -= overflow;
    }
    return snapshot();
  };

  return {
    snapshot,
    current,
    canGoBack: () => index > 0,
    canGoForward: () => index >= 0 && index < entries.length - 1,
    push: (entry) => commit(entry, "push"),
    replace: (entry) => commit(entry, "replace"),
    back: () => {
      if (index <= 0) return null;
      index -= 1;
      return current();
    },
    forward: () => {
      if (index < 0 || index >= entries.length - 1) return null;
      index += 1;
      return current();
    },
    recordScroll: (scroll) => {
      if (index < 0) return snapshot();
      const current = entries[index]!;
      entries = [
        ...entries.slice(0, index),
        { ...current, scroll: canonicalizeScroll(scroll) },
        ...entries.slice(index + 1),
      ];
      return snapshot();
    },
    filter: (keep) => {
      if (entries.length === 0) return snapshot();
      const current = index >= 0 ? entries[index]! : null;
      const currentKey = current ? canonicalEntryKey(current) : null;
      const next = entries.filter(keep);
      if (next.length === 0) {
        entries = [];
        index = -1;
        return snapshot();
      }
      let nextIndex = currentKey
        ? next.findIndex((item) => canonicalEntryKey(item) === currentKey)
        : -1;
      if (nextIndex < 0) nextIndex = Math.min(Math.max(index, 0), next.length - 1);
      entries = next;
      index = nextIndex;
      return snapshot();
    },
    clear: () => {
      entries = [];
      index = -1;
    },
  };
}

export function applyNavigationCommit(
  history: NavigationHistory,
  commit: NavigationCommit,
): NavigationHistorySnapshot {
  if (commit.kind === "non-navigation") return history.snapshot();
  return commit.mode === "replace"
    ? history.replace(commit.entry)
    : history.push(commit.entry);
}

export function isNonNavigationReason(
  value: string,
): value is NonNavigationReason {
  return (
    value === "hydration" ||
    value === "polling" ||
    value === "live-session-phase" ||
    value === "background-roster" ||
    value === "cosmetic-sidebar"
  );
}

/**
 * Native/host pending-route payloads use `EmbeddedNavigationTarget`. Convert
 * them onto the history union at the shared-shell boundary. `home` aliases
 * messages and `inbox` aliases notifications. Unsupported targets stay
 * `null` so they cannot consume a history step.
 */
export function destinationFromEmbeddedTarget(
  target: EmbeddedNavigationTarget,
): NavigationDestination | null {
  switch (target.kind) {
    case "home":
    case "messages":
      return { kind: "messages" };
    case "inbox":
      return { kind: "notifications" };
    case "setup-checkout":
      return {
        kind: "setup-checkout",
        companyUid: target.companyUid,
        checkout: target.checkout ?? null,
      };
    case "meetings":
      return { kind: "meetings", meetingId: target.meetingId ?? null };
    case "atlas":
      return { kind: "atlas" };
    case "library":
      return { kind: "library", tab: target.tab };
    case "settings":
      return { kind: "settings", section: target.section ?? null };
    case "channel":
      return {
        kind: "channel",
        channelId: target.channelId,
        replyRootEventId: target.replyRootEventId ?? null,
      };
    case "dm":
      return {
        kind: "dm",
        personUid: target.personUid,
        replyRootEventId: target.replyRootEventId ?? null,
      };
    case "extra": {
      const companyUid =
        trimId(target.companyUid) ?? extraParamCompanyKey(target.param ?? null);
      return {
        kind: "extra",
        page: target.page,
        param: target.param ?? null,
        ...(companyUid ? { companyUid } : {}),
      };
    }
    case "unsupported":
      return null;
  }
}
