/**
 * `rowExtras` — the host's way to decorate a sidebar conversation row.
 *
 * The shared sidebar knows channels and DMs; it does not know what a host
 * associates with them (Sync: the agent sessions bound to a project channel).
 * A host hands `DesktopApp` one function and the sidebar asks it per row:
 * an optional badge next to the title, an optional card shown while the row
 * is hovered, and optional actions appended to the row's context menu. The
 * sidebar mounts what it is handed and never learns what the data means, so
 * `packages/ui` stays free of any host page or platform SDK.
 */
import type { Component } from "svelte";

import type { ConversationRow } from "./sidebar-model.js";

export interface ConversationRowAction {
  /** Stable id — also the `data-testid` suffix of the menu item. */
  id: string;
  label: string;
  onselect: () => void;
}

export interface ConversationRowExtras {
  /** Short text after the row title (e.g. "2 sessions"). */
  badge?: string | null;
  /** Mounted beside the row while it is hovered; receives the row. */
  hoverCard?: Component<{ row: ConversationRow }> | null;
  /** Appended to the row's right-click menu. */
  actions?: ConversationRowAction[];
}

/** Host callback: `null` for a row it has nothing to add to. */
export type RowExtrasResolver = (row: ConversationRow) => ConversationRowExtras | null;
