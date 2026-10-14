/**
 * Deployment access (QA-059): read and change who can open an hq-deploy app.
 *
 * Routes (hq-deploy, see the /deploy skill "Access modes"):
 *   GET  /api/apps/:id/access-policy            current Cognito/password policy
 *   PUT  /api/apps/:id/access-policy            {mode, companyUid, users?, groups?, password?}
 *   POST /api/apps/:id/access-mode              {mode: public|password|private, password?}
 *   GET  /api/apps/:id/allowed-emails           email allowlist (private mode)
 *   POST /api/apps/:id/allowed-emails           {email}
 *   DELETE /api/apps/:id/allowed-emails/:key    key URL-encoded
 *
 * A password typed here is sent once and never read back or kept in state
 * that renders.
 */
import type { AdapterPromise, Json } from "@hq/platform";

export type AccessMode = "public" | "password" | "company" | "selected" | "private";
export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE";

export type DeployAccessRequest = (
  scope: string,
  method: HttpMethod,
  path: string,
  body?: Json,
) => AdapterPromise<Json>;

export const ACCESS_MODES: readonly AccessMode[] = ["public", "password", "company", "selected", "private"];

export const MODE_LABEL: Record<AccessMode, string> = {
  public: "Public",
  password: "Password",
  company: "Company members",
  selected: "Selected people",
  private: "Email allowlist",
};

export const MODE_EXPLAINER: Record<AccessMode, string> = {
  public: "Anyone with the link can open it.",
  password: "Anyone with the link and the password can open it.",
  company: "Signed-in members of this company can open it.",
  selected: "Only the people and groups listed here can open it, after signing in.",
  private: "Only signed-in people whose email or domain is on the list can open it.",
};

export const MIN_PASSWORD = 8;

export interface EmailGrant {
  patternKey: string;
  pattern: string;
}

export interface AccessState {
  mode: AccessMode;
  companyUid: string;
  users: string[];
  groups: string[];
  emails: EmailGrant[];
}

export interface AccessDraft {
  mode: AccessMode;
  users: string[];
  groups: string[];
  emails: string[];
  /** New password. Empty means keep the current one. */
  password: string;
}

export interface AccessStep {
  method: HttpMethod;
  path: string;
  body?: Json;
}

export interface AccessPlan {
  steps: AccessStep[];
  /** Plain lines describing what Save will apply. */
  summary: string[];
  /** Why Save is blocked, when it is. */
  blocked: string | null;
}

/** Hints from the `/api/apps` row; the policy route does not report `private`. */
export interface AppAccessHint {
  privateMode?: boolean;
  passwordProtected?: boolean;
  accessMode?: string | null;
}

export const ACCESS_ERROR_COPY = {
  load: "Couldn't load who can open this deployment. Try again.",
  save: "Couldn't save access. Nothing changed. Try again.",
  noRecord: "This deployment has no access settings here. Access is managed where it was deployed.",
  offline: "Couldn't reach HQ. Check your connection and try again.",
  signedOut: "You're signed out. Sign in again, then try again.",
  forbidden: "Only company admins and owners can change who opens this deployment.",
} as const;

/** Plain copy for an access failure; the raw text goes to the console only. */
export function accessErrorCopy(err: unknown, kind: "load" | "save"): string {
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  console.error(`[deploy-access] ${kind} failed:`, raw || err);
  if (/HTTP 404\b|invalid app id/i.test(raw)) return ACCESS_ERROR_COPY.noRecord;
  if (/^auth:|HTTP 401\b/i.test(raw)) return ACCESS_ERROR_COPY.signedOut;
  if (/HTTP 403\b/i.test(raw)) return ACCESS_ERROR_COPY.forbidden;
  if (/fetch:|network|offline/i.test(raw)) return ACCESS_ERROR_COPY.offline;
  return ACCESS_ERROR_COPY[kind];
}

const base = (appId: string) => `/api/apps/${encodeURIComponent(appId)}`;

/** Thin client over the host request; every call returns the parsed JSON. */
export function deployAccessClient(request: DeployAccessRequest, scope: string) {
  async function run(method: HttpMethod, path: string, body?: Json): Promise<Json> {
    const res = await request(scope, method, path, body);
    if (!res.ok) throw new Error(res.message ?? res.reason ?? "Request failed");
    return (res.value ?? {}) as Json;
  }
  return {
    run,
    getPolicy: (appId: string) => run("GET", `${base(appId)}/access-policy`),
    putPolicy: (
      appId: string,
      body: { mode: "public" | "password" | "company" | "selected"; companyUid: string; users?: { id: string }[]; groups?: { id: string }[]; password?: string },
    ) => run("PUT", `${base(appId)}/access-policy`, body as unknown as Json),
    setMode: (appId: string, body: { mode: "public" | "password" | "private"; password?: string }) =>
      run("POST", `${base(appId)}/access-mode`, body as unknown as Json),
    listEmails: (appId: string) => run("GET", `${base(appId)}/allowed-emails`),
    addEmail: (appId: string, email: string) => run("POST", `${base(appId)}/allowed-emails`, { email }),
    removeEmail: (appId: string, patternKey: string) =>
      run("DELETE", `${base(appId)}/allowed-emails/${encodeURIComponent(patternKey)}`),
  };
}

export type DeployAccessClient = ReturnType<typeof deployAccessClient>;

function ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (v && typeof v === "object" ? (v as { id?: unknown }).id : v))
    .filter((id): id is string => typeof id === "string" && id.trim().length > 0);
}

function emailRows(value: unknown): EmailGrant[] {
  const list = (value as { emails?: unknown })?.emails;
  if (!Array.isArray(list)) return [];
  const out: EmailGrant[] = [];
  for (const raw of list) {
    const rec = (raw ?? {}) as Record<string, unknown>;
    const pattern = typeof rec.pattern === "string" ? rec.pattern : "";
    const key = typeof rec.patternKey === "string" ? rec.patternKey : pattern;
    if (pattern) out.push({ pattern, patternKey: key });
  }
  return out;
}

/** Read the current access state for one app. */
export async function loadAccess(
  client: DeployAccessClient,
  appId: string,
  hint: AppAccessHint = {},
  fallbackCompanyUid = "",
): Promise<AccessState> {
  if (hint.privateMode === true) {
    const emails = emailRows(await client.listEmails(appId));
    return { mode: "private", companyUid: fallbackCompanyUid, users: [], groups: [], emails };
  }
  const policy = await client.getPolicy(appId);
  const raw = typeof policy.mode === "string" ? policy.mode : "";
  const mode: AccessMode = (ACCESS_MODES as readonly string[]).includes(raw) ? (raw as AccessMode) : hint.passwordProtected ? "password" : "public";
  const companyUid = typeof policy.companyUid === "string" && policy.companyUid ? policy.companyUid : fallbackCompanyUid;
  return { mode, companyUid, users: ids(policy.users), groups: ids(policy.groups), emails: [] };
}

export function draftFrom(state: AccessState): AccessDraft {
  return {
    mode: state.mode,
    users: [...state.users],
    groups: [...state.groups],
    emails: state.emails.map((e) => e.pattern),
    password: "",
  };
}

/** An exact address or an `@domain.tld` pattern, as hq-deploy accepts. */
export function isEmailPattern(value: string): boolean {
  const v = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || /^@[^\s@]+\.[^\s@]+$/.test(v);
}

const norm = (v: string) => v.trim().toLowerCase();

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = new Set(a);
  return x.size === new Set(b).size && b.every((v) => x.has(v));
}

export function isDirty(state: AccessState, draft: AccessDraft): boolean {
  if (draft.mode !== state.mode || draft.password.length > 0) return true;
  if (draft.mode === "selected") return !sameSet(state.users, draft.users) || !sameSet(state.groups, draft.groups);
  if (draft.mode === "private") return !sameSet(state.emails.map((e) => norm(e.pattern)), draft.emails.map(norm));
  return false;
}

/**
 * Turn a draft into the ordered hq-deploy calls plus a plain summary.
 * Leaving the allowlist never opens the app first: the new gate is written,
 * then old allowlist entries are removed so they cannot come back.
 */
export function planAccess(
  state: AccessState,
  draft: AccessDraft,
  appId: string,
  nameFor: (id: string) => string = (id) => id,
): AccessPlan {
  const steps: AccessStep[] = [];
  const summary: string[] = [];
  const p = base(appId);
  const modeChanged = draft.mode !== state.mode;
  const pw = draft.password;
  if (!isDirty(state, draft)) return { steps, summary, blocked: null };

  if (modeChanged) summary.push(`Access changes from ${MODE_LABEL[state.mode]} to ${MODE_LABEL[draft.mode]}. ${MODE_EXPLAINER[draft.mode]}`);
  if (pw && draft.mode !== "password") return { steps: [], summary, blocked: "A password only applies in Password mode." };

  const companyUid = state.companyUid;
  const dropAllowlist = () => {
    if (state.mode !== "private" || state.emails.length === 0) return;
    for (const e of state.emails) steps.push({ method: "DELETE", path: `${p}/allowed-emails/${encodeURIComponent(e.patternKey)}` });
    summary.push(`The ${state.emails.length} allowlist ${state.emails.length === 1 ? "entry is" : "entries are"} removed.`);
  };

  switch (draft.mode) {
    case "public":
      steps.push({ method: "POST", path: `${p}/access-mode`, body: { mode: "public" } });
      break;
    case "password": {
      if (pw.length < MIN_PASSWORD) return { steps: [], summary, blocked: `Enter a password of at least ${MIN_PASSWORD} characters.` };
      if (companyUid && state.mode !== "private") {
        steps.push({ method: "PUT", path: `${p}/access-policy`, body: { mode: "password", companyUid, password: pw } });
      } else {
        steps.push({ method: "POST", path: `${p}/access-mode`, body: { mode: "password", password: pw } });
      }
      summary.push(modeChanged ? "Visitors need the new password." : "The password is replaced. Anyone using the old one is signed out.");
      break;
    }
    case "company":
    case "selected": {
      if (!companyUid) return { steps: [], summary, blocked: "This deployment is not linked to a company, so company access is unavailable." };
      if (draft.mode === "selected" && draft.users.length + draft.groups.length === 0) {
        return { steps: [], summary, blocked: "Add at least one person or group." };
      }
      const body: Json = { mode: draft.mode, companyUid };
      if (draft.mode === "selected") {
        body.users = draft.users.map((id) => ({ id }));
        body.groups = draft.groups.map((id) => ({ id }));
        const added = draft.users.filter((u) => !state.users.includes(u) || modeChanged);
        const removed = modeChanged ? [] : state.users.filter((u) => !draft.users.includes(u));
        if (added.length) summary.push(`Add ${added.map(nameFor).join(", ")}.`);
        if (removed.length) summary.push(`Remove ${removed.map(nameFor).join(", ")}.`);
        const gAdded = draft.groups.filter((g) => !state.groups.includes(g) || modeChanged);
        const gRemoved = modeChanged ? [] : state.groups.filter((g) => !draft.groups.includes(g));
        if (gAdded.length) summary.push(`Add group ${gAdded.join(", ")}.`);
        if (gRemoved.length) summary.push(`Remove group ${gRemoved.join(", ")}.`);
      }
      steps.push({ method: "PUT", path: `${p}/access-policy`, body });
      dropAllowlist();
      break;
    }
    case "private": {
      const want = [...new Set(draft.emails.map(norm))];
      if (want.length === 0) return { steps: [], summary, blocked: "Add at least one email or @domain." };
      const bad = want.find((e) => !isEmailPattern(e));
      if (bad) return { steps: [], summary, blocked: `${bad} is not an email or @domain.` };
      const have = modeChanged ? [] : state.emails;
      if (modeChanged) steps.push({ method: "POST", path: `${p}/access-mode`, body: { mode: "private" } });
      const haveKeys = new Set(have.map((e) => norm(e.pattern)));
      const added = want.filter((e) => !haveKeys.has(e));
      const removed = have.filter((e) => !want.includes(norm(e.pattern)));
      for (const e of added) steps.push({ method: "POST", path: `${p}/allowed-emails`, body: { email: e } });
      for (const e of removed) steps.push({ method: "DELETE", path: `${p}/allowed-emails/${encodeURIComponent(e.patternKey)}` });
      if (added.length) summary.push(`Add ${added.join(", ")}.`);
      if (removed.length) summary.push(`Remove ${removed.map((e) => e.pattern).join(", ")}.`);
      break;
    }
  }
  if (modeChanged && draft.mode !== "private") {
    // Switching modes ends existing visitor sessions (policy version bump).
    summary.push("People who opened it under the old setting sign in again.");
  }
  return { steps, summary, blocked: null };
}

/** Run a plan in order; stops at the first failure. */
export async function applyAccess(client: DeployAccessClient, plan: AccessPlan): Promise<void> {
  for (const step of plan.steps) await client.run(step.method, step.path, step.body);
}
