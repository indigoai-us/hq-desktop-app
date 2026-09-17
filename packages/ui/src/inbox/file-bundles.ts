/**
 * Bundle "added a file" rows so one person dropping a folder into a synced
 * company reads as a single line instead of forty.
 *
 * A sync of a folder emits one new-file event per file. Unbundled, that buries
 * every other notification in the feed. Rows are grouped by actor within a
 * rolling window, newest-first, and rendered as "cnueno@gmail.com added 14
 * files" with the shared folder as context.
 *
 * Pure — no Svelte, no Tauri. Applied at the view layer so the underlying feed
 * rows (and their ack targets) are untouched.
 */

import type { NotificationItem } from "./notifications-model";

/** Rows closer together than this, from one actor, collapse into one row. */
export const FILE_BUNDLE_WINDOW_MS = 10 * 60 * 1000;

export interface FileBundleResult {
  items: NotificationItem[];
  /**
   * Unread rows removed by bundling. The bundle itself counts once, so a
   * caller holding a server unread total subtracts this to keep the bell
   * honest.
   */
  collapsedUnread: number;
}

/**
 * Split a new-file context line ("indigo · reports/q3/deck.pdf") into its
 * company prefix and company-relative path. Rows without a company keep the
 * whole string as the path.
 */
export function splitFileContext(context: string): {
  company: string | null;
  path: string;
} {
  const sep = context.indexOf(" · ");
  if (sep === -1) return { company: null, path: context.trim() };
  return {
    company: context.slice(0, sep).trim() || null,
    path: context.slice(sep + 3).trim(),
  };
}

/** Longest shared directory prefix of the given paths ("" when they share none). */
export function commonFolderPrefix(paths: readonly string[]): string {
  const segmentLists = paths
    .map((path) => path.split("/").filter(Boolean))
    .filter((segments) => segments.length > 0);
  if (segmentLists.length === 0) return "";

  // Drop the file name: the shared FOLDER is the context, not a shared
  // filename prefix.
  const folders = segmentLists.map((segments) => segments.slice(0, -1));
  const first = folders[0]!;
  const shared: string[] = [];
  for (let i = 0; i < first.length; i += 1) {
    const segment = first[i]!;
    if (folders.every((other) => other[i] === segment)) shared.push(segment);
    else break;
  }
  return shared.join("/");
}

function bundleContext(items: readonly NotificationItem[]): string {
  const parts = items.map((item) => splitFileContext(item.contextLine));
  const company = parts.find((part) => part.company)?.company ?? null;
  const sameCompany = parts.every((part) => (part.company ?? null) === company);
  const prefix = commonFolderPrefix(parts.map((part) => part.path));
  if (company && sameCompany) return prefix ? `${company} · ${prefix}` : company;
  return prefix;
}

/**
 * Collapse consecutive-in-time new-file rows per actor.
 *
 * Input may be in any order; output preserves the caller's ordering by putting
 * each bundle where its newest member sat. A single-item bundle keeps the
 * original row untouched, so nothing reads "added 1 files".
 */
export function bundleFileNotifications(
  items: readonly NotificationItem[],
  windowMs: number = FILE_BUNDLE_WINDOW_MS,
): FileBundleResult {
  const groups = new Map<string, NotificationItem[]>();
  for (const item of items) {
    if (item.displayKind !== "new_file") continue;
    const key = item.actorName.trim().toLowerCase() || "?";
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  /** id of the newest member → the bundle it represents. */
  const bundleByAnchor = new Map<string, NotificationItem>();
  /** Every member id that is folded away (including the anchor). */
  const absorbed = new Set<string>();
  let collapsedUnread = 0;

  for (const list of groups.values()) {
    const sorted = [...list].sort((a, b) => b.createdAtMs - a.createdAtMs);
    let run: NotificationItem[] = [];

    const flush = (): void => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const anchor = run[0]!;
      for (const member of run) absorbed.add(member.id);
      collapsedUnread += Math.max(
        0,
        run.filter((item) => item.status === "unread").length - 1,
      );
      bundleByAnchor.set(anchor.id, {
        ...anchor,
        verbText: `${anchor.actorName} added ${run.length} files`,
        contextLine: bundleContext(run),
        status: run.some((item) => item.status === "unread")
          ? "unread"
          : "read",
      });
      run = [];
    };

    for (const item of sorted) {
      if (run.length === 0) {
        run.push(item);
        continue;
      }
      const newest = run[0]!.createdAtMs;
      if (newest - item.createdAtMs <= windowMs) run.push(item);
      else {
        flush();
        run.push(item);
      }
    }
    flush();
  }

  if (bundleByAnchor.size === 0) return { items: [...items], collapsedUnread: 0 };

  const out: NotificationItem[] = [];
  for (const item of items) {
    const bundle = bundleByAnchor.get(item.id);
    if (bundle) {
      out.push(bundle);
      continue;
    }
    if (absorbed.has(item.id)) continue;
    out.push(item);
  }
  return { items: out, collapsedUnread };
}
