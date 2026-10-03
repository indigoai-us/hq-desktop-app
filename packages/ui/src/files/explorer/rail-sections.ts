/**
 * OWNER-R17: the Files right pane folds into sections (Access, Outline,
 * Linked here). Which ones are folded is remembered on this Mac.
 */
export type RailSection = "access" | "outline" | "links";
const RAIL_KEY = "hq.files.rail.collapsed";

export function readCollapsed(storage: Pick<Storage, "getItem"> | null): Record<RailSection, boolean> {
  const none = { access: false, outline: false, links: false };
  try {
    const raw = storage?.getItem(RAIL_KEY);
    if (!raw) return none;
    const parsed = JSON.parse(raw) as Partial<Record<RailSection, unknown>>;
    return { access: parsed.access === true, outline: parsed.outline === true, links: parsed.links === true };
  } catch (err) {
    console.warn("[files] collapsed sections unreadable", err);
    return none;
  }
}

export function writeCollapsed(storage: Pick<Storage, "setItem"> | null, value: Record<RailSection, boolean>): void {
  try {
    storage?.setItem(RAIL_KEY, JSON.stringify(value));
  } catch (err) {
    console.warn("[files] collapsed sections not saved", err);
  }
}
