import {
  ok,
  type AdapterPromise,
  type AdapterResult,
  type BotPersonalApp,
  type BotPersonalAppsApi,
  type BotPersonalAppSignInStatus,
  type BotPersonalCatalogEntry,
  type Json,
} from "./adapter.js";

/**
 * Sends one personal-apps operation to HQ. The server carries these on
 * POST /v1/agents/{uid}/runtime/actions as `actionId: "personalApps.<op>"`
 * with the operation's input in `body`. A failure must keep its HTTP status:
 * 404 means the bot has no personal apps for this person (not the owner, or
 * the feature is off for the company), and the section hides itself.
 */
export type PersonalAppsPost = (
  agentUid: string,
  input: { actionId: string; idempotencyKey: string; body?: Record<string, unknown> },
) => AdapterPromise<Json>;

/** What a sign-in redirect caught on this computer carries back. */
export interface PersonalAppLocalCallback {
  state: string;
  code?: string;
  error?: string;
  iss?: string;
}

/**
 * The desktop's local sign-in listener (Rust `personal_apps_signin_*`). Some
 * apps refuse HQ's public return page but accept a return to `localhost`; HQ
 * then registers the bot's sign-in with that address, and this host catches
 * the redirect and hands it back to HQ. Absent on hosts without one (the web
 * console), which then cannot add or sign in to those apps.
 */
export interface PersonalAppsLocalSignIn {
  /** Bind the listener for this sign-in's state, before the browser opens. */
  listen(state: string): AdapterPromise<string>;
  /** Wait for the redirect (up to 5 minutes). */
  wait(state: string): AdapterPromise<PersonalAppLocalCallback>;
  cancel(state: string): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idempotencyKey(): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `personal-apps-${random}`;
}

/** Server app -> the shape the Personal apps section renders. */
export function personalAppFromServer(value: unknown): BotPersonalApp | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const auth = value.auth === "oauth" ? "oauth" : "none";
  const host = typeof value.host === "string" && value.host ? value.host : null;
  return {
    name: value.name,
    url: host ? `https://${host}` : null,
    auth,
    enabled: value.enabled !== false,
    connected: auth === "oauth" ? value.signedIn === true : true,
    tools: typeof value.toolCount === "number" ? value.toolCount : null,
  };
}

export function personalCatalogEntryFromServer(
  value: unknown,
  canReturnLocally = false,
): BotPersonalCatalogEntry | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const desktopOnly = value.signInReturn === "local";
  return {
    name: value.name,
    description: typeof value.description === "string" ? value.description : "",
    url: typeof value.url === "string" ? value.url : null,
    transport: "http",
    auth: typeof value.auth === "string" ? value.auth : "none",
    installed: false,
    supported: value.supported === true && (!desktopOnly || canReturnLocally),
  };
}

/** Server sign-in status -> the runtime flow states the section polls on. */
export function personalSignInStatusFromServer(value: unknown): BotPersonalAppSignInStatus {
  const status = isRecord(value) ? value.status : undefined;
  const message = isRecord(value) && typeof value.message === "string" ? value.message : null;
  const tools = isRecord(value) && typeof value.toolCount === "number" ? value.toolCount : 0;
  if (status === "connected") return { status: "approved", error: null, tools };
  if (status === "failed") return { status: "error", error: message, tools: 0 };
  return { status: "authorization_required", error: null, tools: 0 };
}

function mapResult<T>(result: AdapterResult<Json>, map: (value: Json) => T): AdapterResult<T> {
  return result.ok ? ok(map(result.value)) : result;
}

function stateOf(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get("state");
  } catch {
    return null;
  }
}

export function createPersonalAppsApi(
  post: PersonalAppsPost,
  local?: PersonalAppsLocalSignIn,
): BotPersonalAppsApi {
  const localReturn = local !== undefined;
  const run = (agentUid: string, op: string, body?: Record<string, unknown>) =>
    post(agentUid, {
      actionId: `personalApps.${op}`,
      idempotencyKey: idempotencyKey(),
      ...(body ? { body } : {}),
    });
  return {
    list: async (uid) =>
      mapResult(await run(uid, "list"), (value) => ({
        apps: (isRecord(value) && Array.isArray(value.apps) ? value.apps : [])
          .map(personalAppFromServer)
          .filter((app): app is BotPersonalApp => app !== null),
      })),
    catalog: async (uid) =>
      mapResult(await run(uid, "catalog"), (value) => ({
        entries: (isRecord(value) && Array.isArray(value.entries) ? value.entries : [])
          .map((entry) => personalCatalogEntryFromServer(entry, localReturn))
          .filter((entry): entry is BotPersonalCatalogEntry => entry !== null),
      })),
    add: (uid, input) =>
      run(uid, "add", { name: input.name, url: input.url, auth: input.auth ?? "oauth", ...(localReturn ? { localReturn } : {}) }),
    remove: (uid, name) => run(uid, "remove", { name }),
    startSignIn: async (uid, name) => {
      const result = await run(uid, "signIn", { name, ...(localReturn ? { localReturn } : {}) });
      if (!result.ok) return result;
      const value = result.value;
      if (!isRecord(value) || typeof value.flowId !== "string" || typeof value.authorizationUrl !== "string") {
        return { ok: false, reason: "error", code: "invalid-response", message: "Sign-in could not start. Try again." };
      }
      const flowId = value.flowId;
      if (value.returnTo === "local") {
        // The app returns to this computer: listen before the browser opens,
        // then hand the redirect to HQ. The section keeps polling the bot.
        const state = stateOf(value.authorizationUrl);
        const listening = local && state ? await local.listen(state) : null;
        if (!local || !state || !listening?.ok) {
          void run(uid, "cancelSignIn", { flowId });
          const busy = listening && !listening.ok && /PORT_IN_USE/.test(listening.message ?? listening.code ?? "");
          return {
            ok: false,
            reason: "error",
            code: busy ? "local-port-in-use" : "local-signin-unavailable",
            message: busy
              ? "Another sign-in is still open in HQ. Finish or close it, then try again."
              : "This app can only be signed in to from HQ Desktop.",
          };
        }
        void local.wait(state).then(async (caught) => {
          if (!caught.ok) return;
          const { state: s, code, error, iss } = caught.value;
          await run(uid, "completeSignIn", {
            state: s,
            ...(code ? { code } : {}),
            ...(error ? { error } : {}),
            ...(iss ? { iss } : {}),
          });
        });
      }
      return ok({ flowId, authorizationUrl: value.authorizationUrl });
    },
    signInStatus: async (uid, flowId) =>
      mapResult(await run(uid, "signInStatus", { flowId }), personalSignInStatusFromServer),
  };
}
