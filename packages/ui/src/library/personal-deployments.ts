/**
 * Personal deployments across scopes (US-031). Cache-first. Status colors
 * stay on the existing live/error tokens. A deploying row keeps its previous
 * build serving until swap.
 */

import { deployProgress, type DeployProgress } from "../company/deploy-progress.js";

export type PersonalDeployStatus =
  | "active"
  | "building"
  | "deploying"
  | "failed"
  | "sleeping"
  | "deactivated";

export type PersonalDeployFilter =
  | "all"
  | "active"
  | "sleeping"
  | "deactivated"
  | "scope-personal"
  | "scope-company"
  | "by-you"
  | "by-bots";

export interface PersonalDeployment {
  id: string;
  name: string;
  host: string;
  project: string;
  detail: string;
  scope: "personal" | "company";
  scopeLabel: string;
  scopeMark: string;
  status: PersonalDeployStatus;
  access: string;
  views30d: number;
  lastVisit: string;
  /** 1-based deploy step when status is deploying or building. */
  step: number | null;
  liveVersion: string;
  nextVersion: string;
  byYou: boolean;
  byBot: boolean;
  log: string[];
}

export interface PersonalDeploymentsCache {
  rows: PersonalDeployment[];
}

const memory = new Map<string, PersonalDeploymentsCache>();

export function readPersonalDeploymentsCache(accountId: string): PersonalDeploymentsCache | null {
  return memory.get(accountId) ?? null;
}

export function writePersonalDeploymentsCache(
  accountId: string,
  value: PersonalDeploymentsCache,
): void {
  if (accountId) memory.set(accountId, value);
}

export function personalDeploymentsFixture(): PersonalDeploymentsCache {
  return {
    rows: [
      {
        id: "storyboard",
        name: "hq-desktop-console-rail-storyboard",
        host: ".indigo-hq.com",
        project: "hq-desktop-console-rail",
        detail: "deployed 41m ago by you",
        scope: "company",
        scopeLabel: "Indigo",
        scopeMark: "IN",
        status: "active",
        access: "Password",
        views30d: 96,
        lastVisit: "3m ago",
        step: null,
        liveVersion: "v4",
        nextVersion: "v5",
        byYou: true,
        byBot: false,
        log: [],
      },
      {
        id: "cut30",
        name: "cut30-week-41",
        host: ".corey.hq-deploy.app",
        project: "cut30",
        detail: "deployed 2h ago by you",
        scope: "personal",
        scopeLabel: "Personal",
        scopeMark: "CE",
        status: "active",
        access: "Only you",
        views30d: 18,
        lastVisit: "22m ago",
        step: null,
        liveVersion: "v2",
        nextVersion: "v3",
        byYou: true,
        byBot: false,
        log: [],
      },
      {
        id: "standup",
        name: "indigo-standup-report",
        host: ".indigo-hq.com",
        project: "standup-brief",
        detail: "deployed 2h ago by deacon",
        scope: "company",
        scopeLabel: "Indigo",
        scopeMark: "IN",
        status: "active",
        access: "Company",
        views30d: 1284,
        lastVisit: "6m ago",
        step: null,
        liveVersion: "v9",
        nextVersion: "v10",
        byYou: false,
        byBot: true,
        log: [],
      },
      {
        id: "interview",
        name: "personal-interview",
        host: ".corey.hq-deploy.app",
        project: "personal-interview",
        detail: "building · 2/5 · deacon",
        scope: "personal",
        scopeLabel: "Personal",
        scopeMark: "CE",
        status: "building",
        access: "Only you",
        views30d: 0,
        lastVisit: "—",
        step: 2,
        liveVersion: "v1",
        nextVersion: "v2",
        byYou: false,
        byBot: true,
        log: ["pack ok", "build running"],
      },
      {
        id: "ontology",
        name: "ontology-explorer",
        host: ".indigo-hq.com",
        project: "ontology",
        detail: "last deploy failed 32m ago · build step 3/5",
        scope: "company",
        scopeLabel: "Indigo",
        scopeMark: "IN",
        status: "failed",
        access: "Company",
        views30d: 40,
        lastVisit: "4d ago",
        step: 3,
        liveVersion: "v6",
        nextVersion: "v7",
        byYou: true,
        byBot: false,
        log: ["build failed"],
      },
      {
        id: "sleep",
        name: "telemetry-sep-export",
        host: ".corey.hq-deploy.app",
        project: "exports",
        detail: "deployed 12d ago by you",
        scope: "personal",
        scopeLabel: "Personal",
        scopeMark: "CE",
        status: "sleeping",
        access: "Link",
        views30d: 6,
        lastVisit: "9d ago",
        step: null,
        liveVersion: "v1",
        nextVersion: "v1",
        byYou: true,
        byBot: false,
        log: [],
      },
      {
        id: "off",
        name: "rail-idea-v1",
        host: ".corey.hq-deploy.app",
        project: "drafts",
        detail: "deactivated Sep 12 · delete after Oct 12",
        scope: "personal",
        scopeLabel: "Personal",
        scopeMark: "CE",
        status: "deactivated",
        access: "Only you",
        views30d: 0,
        lastVisit: "24d ago",
        step: null,
        liveVersion: "v1",
        nextVersion: "v1",
        byYou: true,
        byBot: false,
        log: [],
      },
    ],
  };
}

export function filterDeployments(
  rows: readonly PersonalDeployment[],
  filter: PersonalDeployFilter,
  query: string,
): PersonalDeployment[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter === "active" && row.status !== "active" && row.status !== "deploying" && row.status !== "building") {
      return false;
    }
    if (filter === "sleeping" && row.status !== "sleeping") return false;
    if (filter === "deactivated" && row.status !== "deactivated") return false;
    if (filter === "scope-personal" && row.scope !== "personal") return false;
    if (filter === "scope-company" && row.scope !== "company") return false;
    if (filter === "by-you" && !row.byYou) return false;
    if (filter === "by-bots" && !row.byBot) return false;
    if (!q) return true;
    return `${row.name} ${row.host} ${row.project} ${row.scopeLabel}`.toLowerCase().includes(q);
  });
}

/** Start a redeploy. The previous version keeps serving until swap. */
export function beginRedeploy(row: PersonalDeployment): PersonalDeployment {
  return {
    ...row,
    status: "deploying",
    step: 3,
    detail: `${row.project} · redeploying · step 3/5 · ${row.liveVersion} stays live until swap`,
    log: [
      ...(row.log ?? []),
      "pack ok",
      "build ok",
      "upload running",
    ],
  };
}

export function progressFor(row: PersonalDeployment): DeployProgress {
  return deployProgress({
    step: row.step,
    liveVersion: row.liveVersion,
    nextVersion: row.nextVersion,
  });
}

export function statusLabel(row: PersonalDeployment): string {
  if (row.status === "deploying") {
    const step = progressFor(row).step;
    return `Deploying · ${step}/5`;
  }
  if (row.status === "building") return "Building";
  if (row.status === "failed") return "Failed";
  if (row.status === "sleeping") return "Sleeping";
  if (row.status === "deactivated") return "Deactivated";
  return "Active";
}
