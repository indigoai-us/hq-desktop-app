/**
 * Personal Library model (US-031). Pure data: sections, shared grants, and
 * which file the preview column should show. The page paints this cache
 * immediately and refreshes the file list in the background.
 */

export type PersonalLibrarySection =
  | "mine"
  | "shared"
  | "recent"
  | "starred"
  | "company"
  | "local";

export interface PersonalLibraryFile {
  id: string;
  name: string;
  path: string;
  meta: string;
  preview: string;
  starred?: boolean;
  recent?: boolean;
}

export interface SharedGrant {
  id: string;
  name: string;
  parent: string;
  path: string;
  owner: string;
  ownerMark: string;
  company: string;
  companyMark: string;
  /** Grant levels are read and write only. */
  access: "read" | "write";
  expires: string;
  expired: boolean;
  preview: string;
}

export interface PersonalLibraryCache {
  files: PersonalLibraryFile[];
  grants: SharedGrant[];
  fileCount: number;
}

const memory = new Map<string, PersonalLibraryCache>();

export function readPersonalLibraryCache(accountId: string): PersonalLibraryCache | null {
  return memory.get(accountId) ?? null;
}

export function writePersonalLibraryCache(accountId: string, value: PersonalLibraryCache): void {
  if (accountId) memory.set(accountId, value);
}

export function personalLibraryFixture(): PersonalLibraryCache {
  return {
    fileCount: 1204,
    files: [
      {
        id: "week-41",
        name: "week-41-plan.md",
        path: "personal/projects/cut30/week-41-plan.md",
        meta: "Markdown · personal/projects/cut30",
        preview: "# Cut30 — week 41 plan\n\nFormats this week: 2 one-shots, 1 prop yap, 1 ten-shot.",
        recent: true,
        starred: true,
      },
      {
        id: "idea-bank",
        name: "idea-bank.md",
        path: "personal/projects/cut30/idea-bank.md",
        meta: "Markdown · personal/projects/cut30",
        preview: "# Idea bank\n\nTwelve new, four promoted.",
        recent: true,
      },
      {
        id: "voice",
        name: "voice-and-output-hierarchy.md",
        path: "personal/knowledge/voice-and-output-hierarchy.md",
        meta: "Markdown · personal/knowledge",
        preview: "# Voice\n\nPlain language. No mannered closers.",
      },
    ],
    grants: [
      {
        id: "billing",
        name: "agent-billing-seams.md",
        parent: "projects/agent-billing",
        path: "companies/indigo/projects/agent-billing/agent-billing-seams.md",
        owner: "Eric B.",
        ownerMark: "EB",
        company: "Indigo",
        companyMark: "IN",
        access: "read",
        expires: "never",
        expired: false,
        preview: "# Agent billing seams\n\nWhere agent cost attaches to a company invoice.",
      },
      {
        id: "dunning",
        name: "dunning-reconcile/",
        parent: "projects · 14 files",
        path: "companies/liverecover/projects/dunning-reconcile",
        owner: "Hassaan",
        ownerMark: "HS",
        company: "LiveRecover",
        companyMark: "LR",
        access: "write",
        expires: "in 12 d · Oct 13",
        expired: false,
        preview: "# dunning-reconcile\n\nFolder shared with write.",
      },
      {
        id: "scout",
        name: "weekly-scan/",
        parent: "bots/scout · 6 files",
        path: "companies/indigo/bots/scout/weekly-scan",
        owner: "scout",
        ownerMark: "⌁",
        company: "Indigo",
        companyMark: "IN",
        access: "read",
        expires: "in 30 d · Oct 31",
        expired: false,
        preview: "# weekly-scan\n\nRead grant from scout.",
      },
      {
        id: "q3",
        name: "q3-brand-review.md",
        parent: "drafts",
        path: "companies/indigo/drafts/q3-brand-review.md",
        owner: "Izzy",
        ownerMark: "IZ",
        company: "Indigo",
        companyMark: "IN",
        access: "read",
        expires: "Sep 20",
        expired: true,
        preview: "# Q3 brand review\n\nThis grant has expired.",
      },
    ],
  };
}

export function filesForSection(
  cache: PersonalLibraryCache,
  section: PersonalLibrarySection,
): PersonalLibraryFile[] {
  if (section === "starred") return cache.files.filter((file) => file.starred);
  if (section === "recent") return cache.files.filter((file) => file.recent);
  if (section === "mine" || section === "local") return cache.files;
  return [];
}

/** The preview column follows the selected shared row. */
export function sharedGrantPreview(
  grants: readonly SharedGrant[],
  id: string | null,
): SharedGrant | null {
  if (!id) return grants.find((grant) => !grant.expired) ?? grants[0] ?? null;
  return grants.find((grant) => grant.id === id) ?? null;
}

export function activeGrants(grants: readonly SharedGrant[]): SharedGrant[] {
  return grants.filter((grant) => !grant.expired);
}

export function expiredGrants(grants: readonly SharedGrant[]): SharedGrant[] {
  return grants.filter((grant) => grant.expired);
}
