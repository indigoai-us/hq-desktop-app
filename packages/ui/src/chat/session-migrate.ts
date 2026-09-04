/**
 * Cross-company session migrate helpers (US-017B desktop).
 *
 * Digest material mirrors hq-pro `migrateDigestPayload` then SHA-256 hex.
 * `migrateSession` on WorkMeshApi is the only client rebind path.
 */

import type { WorkspaceLike } from "./channel-admin.js";
export { canMigrateCompanySession } from "../avatars/can-edit.js";

export interface MigrateDestination {
  projectId?: string;
  taskId?: string;
}

export interface MigrateDigestParts {
  sessionId: string;
  sourceCompanyUid: string;
  destinationCompanyUid: string;
  destination: MigrateDestination;
  expectedVersion: number;
}

export interface MigrateCompanyOption {
  uid: string;
  label: string;
}

type CompanyRow = WorkspaceLike & {
  displayName?: string | null;
};

function hexSha256(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Canonical JSON string — same field order/shape as hq-pro migrateDigestPayload. */
export function migrateDigestPayload(parts: MigrateDigestParts): string {
  return JSON.stringify({
    sessionId: parts.sessionId,
    sourceCompanyUid: parts.sourceCompanyUid,
    destinationCompanyUid: parts.destinationCompanyUid,
    destination: {
      ...(parts.destination.projectId
        ? { projectId: parts.destination.projectId }
        : {}),
      ...(parts.destination.taskId ? { taskId: parts.destination.taskId } : {}),
    },
    expectedVersion: parts.expectedVersion,
  });
}

/** SHA-256 hex of migrateDigestPayload JSON. */
export async function digestMigratePayload(
  parts: MigrateDigestParts,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(migrateDigestPayload(parts)),
  );
  return hexSha256(digest);
}

/** Fresh operation id with stable `op_` prefix. */
export function newMigrateOperationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `op_${crypto.randomUUID().replace(/-/g, "")}`;
  }
  return `op_${Date.now().toString(16)}${Math.random().toString(16).slice(2, 10)}`;
}

/** Active non-personal companies excluding the source (guest roles omitted). */
export function migrateDestinationCompanies(
  companies: ReadonlyArray<CompanyRow> | null | undefined,
  sourceCompanyUid: string,
): MigrateCompanyOption[] {
  const source = sourceCompanyUid.trim();
  const out: MigrateCompanyOption[] = [];
  for (const w of companies ?? []) {
    if (w.kind === "personal") continue;
    const uid = (w.cloudUid ?? "").trim();
    if (!uid || uid === source) continue;
    const active =
      (w.membershipStatus ?? "active").toLowerCase() === "active";
    if (!active) continue;
    const role = (w.role ?? "").trim().toLowerCase();
    if (role === "guest") continue;
    const label =
      (w.displayName ?? "").trim() || (w.slug ?? "").trim() || uid;
    out.push({ uid, label });
  }
  return out;
}

export function normalizeMigrateDestination(
  destination?: MigrateDestination | null,
): MigrateDestination {
  const out: MigrateDestination = {};
  const projectId = destination?.projectId?.trim();
  const taskId = destination?.taskId?.trim();
  if (projectId) out.projectId = projectId;
  if (taskId) out.taskId = taskId;
  return out;
}
