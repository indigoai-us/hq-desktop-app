/**
 * Agent-join notifications: suppress by default, bundle for whoever owns the
 * fleet.
 *
 * Creating an agent announces it to every member of the company. A day of
 * fleet work therefore drops dozens of "🤖 v3e2e-1a2b (an agent) just joined
 * Indigo." rows into every teammate's feed — none of which they asked for or
 * can act on. Two rules, the same shape #910 used for file adds:
 *
 *  - a viewer who does not run the fleet sees none of them;
 *  - a viewer who does sees one row per company per 10-minute window
 *    ("3 agents joined Indigo").
 *
 * Pure — applied at the view layer, so the underlying feed rows and their ack
 * targets are untouched.
 */

import { automatedAgentJoinNoticeKey } from "./automated-notices";
import type { NotificationItem } from "./notifications-model";

/** Join rows closer together than this collapse into one row. */
export const AGENT_JOIN_BUNDLE_WINDOW_MS = 10 * 60 * 1000;

export interface AgentJoinBundleOptions {
  /**
   * True when this viewer owns/creates agents for the company and should still
   * see (bundled) join rows. Default false — a teammate who did not create the
   * agent gets nothing.
   *
   * hq-pro does not yet stamp "you created this agent" on the notification, so
   * the shell passes this from company role once that signal exists.
   */
  viewerOwnsAgents?: boolean;
  windowMs?: number;
}

export interface AgentJoinBundleResult {
  items: NotificationItem[];
  /**
   * Unread rows removed (suppressed or folded away). A caller holding a server
   * unread total subtracts this so the bell stays honest.
   */
  collapsedUnread: number;
}

/**
 * True when a feed row is the server's agent membership announcement.
 *
 * The feed row has no sender uid on `actorPersonUid` for every server
 * generation, so the copy check does the work; `automatedAgentJoinNoticeKey`
 * still refuses a human quoting the same words when a human uid is present.
 */
export function isAgentJoinNotification(item: NotificationItem): boolean {
  if (item.displayKind !== "dm_received" && item.displayKind !== "generic") {
    return false;
  }
  const body = item.contextLine?.trim();
  if (!body) return false;
  return (
    automatedAgentJoinNoticeKey({
      kind: "dm",
      body,
      fromPersonUid: item.actorPersonUid,
      fromDisplayName: item.actorName,
    }) !== null
  );
}

/** The company named by a join notice ("… just joined Indigo." → "Indigo"). */
export function companyFromJoinNotice(body: string): string | null {
  const match = body
    .trim()
    .replace(/\s+/g, " ")
    .match(/just joined\s+(.+?)\.\s*$/iu);
  return match ? match[1]!.trim() || null : null;
}

/**
 * Suppress or bundle agent-join rows.
 *
 * Input may be in any order; output preserves the caller's ordering by putting
 * each bundle where its newest member sat. A lone join row for a fleet owner
 * stays as-is, so nothing reads "1 agents joined".
 */
export function bundleAgentJoinNotifications(
  items: readonly NotificationItem[],
  options: AgentJoinBundleOptions = {},
): AgentJoinBundleResult {
  const windowMs = options.windowMs ?? AGENT_JOIN_BUNDLE_WINDOW_MS;
  const joins = items.filter(isAgentJoinNotification);
  if (joins.length === 0) return { items: [...items], collapsedUnread: 0 };

  if (options.viewerOwnsAgents !== true) {
    const joinIds = new Set(joins.map((item) => item.id));
    return {
      items: items.filter((item) => !joinIds.has(item.id)),
      collapsedUnread: joins.filter((item) => item.status === "unread").length,
    };
  }

  const groups = new Map<string, NotificationItem[]>();
  for (const item of joins) {
    const key = (companyFromJoinNotice(item.contextLine) ?? "").toLowerCase();
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }

  const bundleByAnchor = new Map<string, NotificationItem>();
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
      const company = companyFromJoinNotice(anchor.contextLine);
      bundleByAnchor.set(anchor.id, {
        ...anchor,
        actorName: "Agents",
        actorInitials: "AG",
        verbText: company
          ? `${run.length} agents joined ${company}`
          : `${run.length} agents joined`,
        contextLine: run
          .map((item) => item.actorName)
          .filter(Boolean)
          .join(", "),
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

  if (bundleByAnchor.size === 0) {
    return { items: [...items], collapsedUnread: 0 };
  }

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
