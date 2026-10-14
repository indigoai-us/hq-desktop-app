/**
 * New project sheet model (US-023): project id, Claude Code prompt, and the
 * LinkPicker options for linking a goal key result.
 *
 * There is no native create-project call yet, so Create hands the request to
 * Claude Code (the same hand-off Link goal uses). The prompt is built here so
 * the wire shape stays unit-tested.
 */
import type { Objective } from "./local-projects.js";

export type NewProjectStart = "blank" | "brainstorm" | "prd";
export type NewProjectLocation = "repo" | "vault";

export const NEW_PROJECT_START_LABEL: Record<NewProjectStart, string> = {
  blank: "Blank",
  brainstorm: "Brainstorm",
  prd: "PRD",
};

export interface NewProjectDraft {
  name: string;
  company: string;
  location: NewProjectLocation;
  repo: string;
  owner: string;
  link: LinkPickerOption | null;
  start: NewProjectStart;
}

/** Lowercase, dash-separated project id from a free-text name. */
export function projectSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function vaultProjectPath(company: string, id: string): string {
  return ["companies", company, "projects", id || "<project>"].join("/");
}

export function startHint(start: NewProjectStart, id: string): string {
  const name = id || "<project>";
  if (start === "brainstorm") return `/brainstorm ${name}`;
  if (start === "prd") return `/prd ${name}`;
  return "";
}

export function newProjectPrompt(draft: NewProjectDraft): string {
  const id = projectSlug(draft.name);
  const command = startHint(draft.start, id);
  const lines = [
    command || null,
    command ? "" : null,
    `Create the HQ project "${draft.name.trim()}" for company ${draft.company}.`,
    `Project id: ${id}`,
    `Vault folder: ${vaultProjectPath(draft.company, id)}`,
    draft.location === "repo" && draft.repo.trim()
      ? `Repo: ${draft.repo.trim()} (create the feature branch on the first story)`
      : "Vault only: no repo link.",
    draft.owner.trim() ? `Owner: ${draft.owner.trim()}` : null,
    draft.link ? `Linked goal: ${draft.link.label}` : null,
    "Add it to the company board as Not started.",
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

export interface LinkPickerOption {
  /** Stable id: objective id, or objective id + "#" + key result id. */
  id: string;
  kind: "goal" | "kr";
  /** "Goal › Key result" for KRs, goal title for goals. */
  label: string;
  title: string;
  /** Parent goal title. */
  section: string;
}

export function linkPickerOptions(
  objectives: readonly Objective[],
  query = "",
): LinkPickerOption[] {
  const q = query.trim().toLowerCase();
  const out: LinkPickerOption[] = [];
  for (const goal of objectives) {
    const goalTitle = goal.title || goal.id;
    const goalRow: LinkPickerOption = {
      id: goal.id,
      kind: "goal",
      label: goalTitle,
      title: goalTitle,
      section: goalTitle,
    };
    const krs = (goal.keyResults ?? []).map((kr, index) => {
      const title = kr.title || kr.metric || kr.id || `Key result ${index + 1}`;
      return {
        id: `${goal.id}#${kr.id ?? index}`,
        kind: "kr" as const,
        label: `${goalTitle} › ${title}`,
        title,
        section: goalTitle,
      };
    });
    for (const row of [goalRow, ...krs]) {
      if (!q || row.label.toLowerCase().includes(q)) out.push(row);
    }
  }
  return out;
}

/**
 * Company tabs for the New project sheet. With the rail roster (QA-050) the
 * tabs are exactly that list — Personal first, then member companies — so
 * local-only manifest companies never appear. Without it (stories, tests)
 * fall back to the current company plus any seen in projects.
 */
export function newProjectCompanies(
  current: string,
  roster: readonly string[] | null | undefined,
  seen: readonly (string | null | undefined)[] = [],
): string[] {
  if (roster && roster.length > 0) return [...new Set(roster)];
  return [current, ...new Set(seen.filter((c): c is string => !!c && c !== current))];
}

/** Default tab: the current company when it is a target, else the first tab. */
export function newProjectDefaultCompany(current: string, companies: readonly string[]): string {
  return companies.includes(current) ? current : (companies[0] ?? current);
}
