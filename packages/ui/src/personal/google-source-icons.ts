/**
 * Google's official product icons for the Connected sources list, bundled
 * locally (never hotlinked). Files are unmodified downloads from Google's
 * product logo host; source URLs are listed in google-icons/SOURCES.md.
 */
const ICONS: Record<string, string> = {
  calendar: new URL("./google-icons/calendar.svg", import.meta.url).href,
  contacts: new URL("./google-icons/contacts.svg", import.meta.url).href,
  docs: new URL("./google-icons/docs.svg", import.meta.url).href,
  drive: new URL("./google-icons/drive.svg", import.meta.url).href,
  gmail: new URL("./google-icons/gmail.svg", import.meta.url).href,
  sheets: new URL("./google-icons/sheets.svg", import.meta.url).href,
};

/** Icon URL for a source name (case-insensitive), or null for the neutral fallback. */
export function sourceIconUrl(name: unknown): string | null {
  if (typeof name !== "string") return null;
  return ICONS[name.trim().toLowerCase()] || null;
}

/** Source names as a clean string list, whatever shape arrived. */
export function sourceNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}
