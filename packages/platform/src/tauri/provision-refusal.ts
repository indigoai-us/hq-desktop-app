/**
 * What the server says when a person may not add bots to a company.
 *
 * `GET /v1/agents/provision-options` answers 403 for a member without the
 * `createAgents` capability. For a company with the New Bot flow the body
 * also carries `code: "CREATE_AGENTS_NOT_ALLOWED"` and `admins`, the people
 * who can add a bot or grant the capability. The shared error parser keeps
 * the code and drops the list, so the New Bot screen could only show a
 * disabled button. This reads the list back off the body and hands it on
 * with the failure.
 */

import type { AdapterFailure, AdapterResult } from "../adapter.js";

/** One person who can add a bot to the company. */
export interface CreateAgentsAdmin {
  personUid: string;
  displayName: string;
}

/** A provision-options refusal, with the people to ask when the server named them. */
export type ProvisionOptionsFailure = AdapterFailure & { admins?: CreateAgentsAdmin[] };

/** The server lists at most a handful; never carry more than this many. */
const MAX_ADMINS = 10;
const MAX_NAME_CHARS = 80;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The `admins` list of an error body, or an empty list. Never throws. */
export function createAgentsAdminsFromBody(body: string | null | undefined): CreateAgentsAdmin[] {
  if (!body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const list = (parsed as { admins?: unknown } | null)?.admins;
  if (!Array.isArray(list)) return [];
  const admins: CreateAgentsAdmin[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const personUid = text(row.personUid);
    const displayName = text(row.displayName).slice(0, MAX_NAME_CHARS);
    if (!personUid || !displayName) continue;
    admins.push({ personUid, displayName });
    if (admins.length >= MAX_ADMINS) break;
  }
  return admins;
}

/** A failed provision-options read, with the server's `admins` when its body named any. */
export function withCreateAgentsAdmins<T>(
  result: AdapterResult<T>,
  body: string | null | undefined,
): AdapterResult<T> {
  if (result.ok) return result;
  const admins = createAgentsAdminsFromBody(body);
  if (admins.length === 0) return result;
  const failure: ProvisionOptionsFailure = { ...result, admins };
  return failure;
}
