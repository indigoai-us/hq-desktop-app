/**
 * Desktop client for POST /outpost/company/signin.
 *
 * status reads the card. code hands the box a verification code. regenerate
 * asks the server to drop the current link (it removes claudeLoginUrl) and
 * mint another. The code is never written to a log and never returned.
 */
import type { CompanySignInRole, CompanySignInView, SignInFailure } from "./company-signin-model.js";
import { parseCompanySignInBody } from "./company-signin-model.js";

export interface CompanySignInRequest {
  companyUid: string;
  action: "status" | "code" | "regenerate";
  outpostId?: string;
  code?: string;
}

export type CompanySignInPostResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number | null; code?: string; message?: string };

export type CompanySignInPost = (body: CompanySignInRequest) => Promise<CompanySignInPostResult>;

export type CompanySignInCall =
  | { ok: true; view: CompanySignInView }
  | { ok: false; reason: SignInFailure };

export type CompanySignInWrite =
  | { ok: true }
  | { ok: false; reason: SignInFailure };

export interface CompanySignInClient {
  read(): Promise<CompanySignInCall>;
  regenerate(): Promise<CompanySignInWrite>;
  submitCode(code: string): Promise<CompanySignInWrite>;
}

function reasonFor(result: Extract<CompanySignInPostResult, { ok: false }>): SignInFailure {
  const code = result.code ?? "";
  if (code === "invalid_login_code") return "rejected";
  if (code === "admin_required" || result.status === 403) return "not_admin";
  if (code === "signin_not_started" || code === "confirmed_host_required") return "not_ready";
  if (code === "signin_box_changed") return "link_changed";
  if (
    result.status === null
    || (typeof result.status === "number" && result.status >= 500)
    || code === "network"
    || code === "company_signin_unavailable"
  ) {
    return "unreachable";
  }
  return "unavailable";
}

export function createCompanySignInClient(input: {
  companyUid: string;
  outpostId?: string;
  role: CompanySignInRole;
  post: CompanySignInPost;
}): CompanySignInClient {
  const canManage = input.role === "owner" || input.role === "admin";
  const base = () => ({
    companyUid: input.companyUid,
    ...(input.outpostId ? { outpostId: input.outpostId } : {}),
  });

  return {
    async read() {
      if (!canManage) return { ok: true, view: { signedIn: false, state: "unknown" } };
      const result = await input.post({ ...base(), action: "status" });
      if (!result.ok) return { ok: false, reason: reasonFor(result) };
      const view = parseCompanySignInBody(result.body);
      // Own property even when absent, so a regenerated status cannot still carry the old link.
      return { ok: true, view: { ...view, loginUrl: view.loginUrl } };
    },
    async regenerate() {
      if (!canManage) return { ok: false, reason: "not_admin" };
      const result = await input.post({ ...base(), action: "regenerate" });
      if (!result.ok) {
        if (result.code === "already_signed_in") return { ok: true };
        return { ok: false, reason: reasonFor(result) };
      }
      return { ok: true };
    },
    async submitCode(code) {
      if (!canManage) return { ok: false, reason: "not_admin" };
      const trimmed = code.trim();
      if (!trimmed) return { ok: false, reason: "rejected" };
      const result = await input.post({ ...base(), action: "code", code: trimmed });
      if (!result.ok) {
        if (result.code === "already_signed_in") return { ok: true };
        return { ok: false, reason: reasonFor(result) };
      }
      return { ok: true };
    },
  };
}
