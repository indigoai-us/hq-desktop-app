/**
 * Company-channel tab models (US-015).
 *
 * Chat is the feed. Atlas / Team / Integrations / Settings swap the feed
 * for current-state rows returned by GET /v1/companies/{uid}/tabs/{tab}.
 */

import {
  parseLifecycleCard,
  type LifecycleCardActionEvent,
  type LifecycleCardModel,
} from "../messaging/channelMessageModels.js";

export const COMPANY_CHANNEL_TABS = [
  { id: "chat", label: "Chat" },
  { id: "atlas", label: "Atlas" },
  { id: "team", label: "Team" },
  { id: "integrations", label: "Integrations" },
  { id: "settings", label: "Settings" },
] as const;

export type CompanyChannelTabId = (typeof COMPANY_CHANNEL_TABS)[number]["id"];

export type CompanyTabSurfaceId = Exclude<CompanyChannelTabId, "chat">;

export interface CompanyTabSectionModel {
  id: string;
  title: string;
  rows: LifecycleCardModel[];
}

export interface CompanyTabModel {
  tab: CompanyTabSurfaceId | string;
  companyUid: string;
  viewer: { canAct: boolean; role?: string };
  sections: CompanyTabSectionModel[];
}

export interface CompanyTabActionEvent extends LifecycleCardActionEvent {
  tab: string;
  companyUid: string;
}

export function isCompanyChannelTabId(id: string): id is CompanyChannelTabId {
  return COMPANY_CHANNEL_TABS.some((tab) => tab.id === id);
}

export function needsInlineConfirm(
  row: LifecycleCardModel,
  actionId: string,
  values: Record<string, string>,
): boolean {
  if (actionId === "remove") return true;
  if (actionId !== "set_role") return false;
  const current = row.fields.find((field) => field.id === "role")?.value;
  const next = values.role ?? current;
  return current === "owner" || next === "owner";
}

export function parseCompanyTab(raw: unknown): CompanyTabModel | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.tab !== "string" || row.tab.length === 0) return null;
  if (typeof row.companyUid !== "string" || row.companyUid.length === 0) {
    return null;
  }
  if (!Array.isArray(row.sections)) return null;
  const viewerRaw =
    row.viewer && typeof row.viewer === "object" && !Array.isArray(row.viewer)
      ? (row.viewer as Record<string, unknown>)
      : {};
  const sections: CompanyTabSectionModel[] = [];
  for (const section of row.sections) {
    if (!section || typeof section !== "object" || Array.isArray(section)) {
      return null;
    }
    const sec = section as Record<string, unknown>;
    if (typeof sec.id !== "string" || typeof sec.title !== "string") return null;
    if (!Array.isArray(sec.rows)) return null;
    const rows: LifecycleCardModel[] = [];
    for (const item of sec.rows) {
      const parsed = parseLifecycleCard(item);
      if (!parsed || parsed.cardKind !== "tab_row") return null;
      rows.push(parsed);
    }
    sections.push({ id: sec.id, title: sec.title, rows });
  }
  return {
    tab: row.tab,
    companyUid: row.companyUid,
    viewer: {
      canAct: viewerRaw.canAct !== false,
      role: typeof viewerRaw.role === "string" ? viewerRaw.role : undefined,
    },
    sections,
  };
}

export function fieldValue(
  row: LifecycleCardModel,
  id: string,
): string {
  return row.fields.find((field) => field.id === id)?.value ?? "";
}

export function visibleFields(row: LifecycleCardModel): LifecycleCardModel["fields"] {
  return row.fields.filter(
    (field) =>
      field.id !== "section" &&
      field.id !== "membershipKey" &&
      field.id !== "agentUid",
  );
}

export function agentMetaLine(row: LifecycleCardModel): string | null {
  const size = fieldValue(row, "size");
  const provider = fieldValue(row, "provider");
  const price = fieldValue(row, "price");
  if (!size && !provider && !price) return null;
  const sizeLabel = size ? size.charAt(0).toUpperCase() + size.slice(1) : "";
  return [sizeLabel, provider, price].filter(Boolean).join(" · ");
}

export function seedRowValues(
  sections: CompanyTabSectionModel[],
): { [cardId: string]: { [fieldId: string]: string } } {
  const next: { [cardId: string]: { [fieldId: string]: string } } = {};
  for (const section of sections) {
    for (const row of section.rows) {
      const seed: { [fieldId: string]: string } = {};
      for (const field of row.fields) seed[field.id] = field.value ?? "";
      next[row.cardId] = seed;
    }
  }
  return next;
}
