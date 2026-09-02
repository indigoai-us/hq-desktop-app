import { resolvePackItemSrc } from "./parse-pack.js";
import type { AvatarPack, AvatarPackItem, AvatarSelection } from "./types.js";

export interface VisiblePackItems {
  pack: AvatarPack;
  items: AvatarPackItem[];
}

export function matchesQuery(
  item: AvatarPackItem,
  pack: AvatarPack,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.id.toLowerCase().includes(q)) return true;
  if (pack.name.toLowerCase().includes(q)) return true;
  return item.tags.some((tag) => tag.toLowerCase().includes(q));
}

export function filterPacks(
  packs: readonly AvatarPack[],
  query: string,
): VisiblePackItems[] {
  const groups: VisiblePackItems[] = [];
  for (const pack of packs) {
    const items = pack.items.filter((item) => matchesQuery(item, pack, query));
    if (items.length === 0) continue;
    groups.push({ pack, items });
  }
  return groups;
}

export interface FlatPickerRow {
  key: string;
  packId: string;
  itemId: string;
  packName: string;
  item: AvatarPackItem;
  src: string;
}

export function flattenVisible(
  groups: readonly VisiblePackItems[],
): FlatPickerRow[] {
  const rows: FlatPickerRow[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      rows.push({
        key: `${group.pack.id}:${item.id}`,
        packId: group.pack.id,
        itemId: item.id,
        packName: group.pack.name,
        item,
        src: resolvePackItemSrc(group.pack, item),
      });
    }
  }
  return rows;
}

export function selectionEquals(
  a: AvatarSelection | null | undefined,
  b: AvatarSelection | null | undefined,
): boolean {
  if (!a || !b) return a === b;
  if (a.kind === "generated" || b.kind === "generated") {
    return a.kind === "generated" && b.kind === "generated";
  }
  return a.packId === b.packId && a.itemId === b.itemId;
}

export function findSelectedRow(
  rows: readonly FlatPickerRow[],
  selection: AvatarSelection | null | undefined,
): FlatPickerRow | null {
  if (!selection || selection.kind !== "item") return null;
  return (
    rows.find(
      (row) => row.packId === selection.packId && row.itemId === selection.itemId,
    ) ?? null
  );
}

export function moveIndex(
  current: number,
  delta: number,
  length: number,
  columns = 4,
): number {
  if (length <= 0) return 0;
  if (delta === 0) return Math.max(0, Math.min(current, length - 1));
  if (delta === 1 || delta === -1) {
    return (current + delta + length) % length;
  }
  const next = current + delta;
  if (next < 0) return current;
  if (next >= length) return current;
  // Keep column when moving by a full row.
  if (Math.abs(delta) === columns && current % columns !== next % columns) {
    return current;
  }
  return next;
}
