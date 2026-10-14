/**
 * Raw `/api/apps` pages for tests and the perf/design harness only. The live
 * page never imports this; it reads hq-deploy through `list_deploy_apps`.
 */

import type { DeployAppsPage } from "./personal-deployments.js";

export const FIXTURE_CALLER_SUB = "fixture-caller";

const day = 86_400_000;

function iso(agoMs: number, now: number): string {
  return new Date(now - agoMs).toISOString();
}

export function deployAppsFixture(scope: string, now: number = Date.now()): DeployAppsPage {
  if (scope === "personal") {
    return {
      callerSub: FIXTURE_CALLER_SUB,
      apps: [
        { id: "cut30", name: "cut30-week-41", subdomain: "cut30-week-41", url: "https://cut30-week-41.indigo-hq.com", status: "active", active: true, accessMode: null, privateMode: true, ownerId: FIXTURE_CALLER_SUB, createdAt: iso(2 * 3_600_000, now), lastVisitAt: iso(22 * 60_000, now), views30d: 18 },
        { id: "sleep", name: "telemetry-sep-export", subdomain: "telemetry-sep-export", url: "https://telemetry-sep-export.indigo-hq.com", status: "sleeping", active: true, accessMode: "public", ownerId: FIXTURE_CALLER_SUB, createdAt: iso(12 * day, now), lastVisitAt: iso(9 * day, now), views30d: 6 },
        { id: "off", name: "rail-idea-v1", subdomain: "rail-idea-v1", url: "https://rail-idea-v1.indigo-hq.com", status: "active", active: false, accessMode: "password", passwordProtected: true, ownerId: FIXTURE_CALLER_SUB, createdAt: iso(24 * day, now), lastVisitAt: null, views30d: null },
      ],
    };
  }
  return {
    callerSub: FIXTURE_CALLER_SUB,
    apps: [
      { id: "storyboard", name: "hq-desktop-console-rail-storyboard", subdomain: "hq-desktop-console-rail-storyboard", url: "https://hq-desktop-console-rail-storyboard.indigo-hq.com", status: "active", active: true, accessMode: "password", passwordProtected: true, ownerId: FIXTURE_CALLER_SUB, createdAt: iso(41 * 60_000, now), lastVisitAt: iso(3 * 60_000, now), views30d: 96 },
      { id: "standup", name: "indigo-standup-report", subdomain: "indigo-standup-report", url: "https://indigo-standup-report.indigo-hq.com", status: "active", active: true, accessMode: "company", ownerId: "someone-else", createdAt: iso(2 * 3_600_000, now), lastVisitAt: iso(6 * 60_000, now), views30d: null },
      { id: "ontology", name: "ontology-explorer", subdomain: "ontology-explorer", url: "https://ontology-explorer.indigo-hq.com", status: "failed", active: true, accessMode: "company", ownerId: FIXTURE_CALLER_SUB, createdAt: iso(4 * day, now), lastVisitAt: iso(4 * day, now), views30d: 40 },
    ],
  };
}
