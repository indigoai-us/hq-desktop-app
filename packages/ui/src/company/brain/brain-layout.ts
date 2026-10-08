/**
 * Brain pages master-detail layout (Knowledge, Policies, Skills, Workers).
 *
 * The list column starts at the app sidebar's width and can be dragged
 * between BRAIN_LIST_MIN and BRAIN_LIST_MAX. The width is saved per page on
 * this machine. Below BRAIN_NARROW_AT the page shows the list, then the
 * detail with a back control.
 */

import type { BrainPageId } from "./brain-model.js";

export const BRAIN_LIST_MIN = 200;
export const BRAIN_LIST_MAX = 480;
/** Container width (px) below which the split collapses to list-then-detail. */
export const BRAIN_NARROW_AT = 720;
/** The sidebar's own default and saved-width key (SidebarResizeHandle). */
const SIDEBAR_DEFAULT = 260;
const SIDEBAR_KEY = "hq.sidebar.width";

type WidthStorage = Pick<Storage, "getItem" | "setItem">;

function storage(): WidthStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function listWidthKey(page: BrainPageId): string {
  return `hq.brain.listWidth.${page}`;
}

export function clampListWidth(value: number): number {
  if (!Number.isFinite(value)) return SIDEBAR_DEFAULT;
  return Math.round(Math.max(BRAIN_LIST_MIN, Math.min(BRAIN_LIST_MAX, value)));
}

/** The left sidebar's width: its saved value when valid, else its default. */
export function sidebarWidth(store: WidthStorage | null = storage()): number {
  const saved = Number(store?.getItem(SIDEBAR_KEY));
  return saved >= 220 && saved <= 440 ? saved : SIDEBAR_DEFAULT;
}

/** Saved width for this page, else the sidebar's width. */
export function readListWidth(page: BrainPageId, store: WidthStorage | null = storage()): number {
  const raw = store?.getItem(listWidthKey(page));
  const saved = raw == null || raw === "" ? NaN : Number(raw);
  if (Number.isFinite(saved) && saved >= BRAIN_LIST_MIN && saved <= BRAIN_LIST_MAX) return saved;
  return clampListWidth(sidebarWidth(store));
}

export function saveListWidth(page: BrainPageId, width: number, store: WidthStorage | null = storage()): void {
  try {
    store?.setItem(listWidthKey(page), String(clampListWidth(width)));
  } catch (err) {
    console.warn("[brain] could not save list width", err);
  }
}
