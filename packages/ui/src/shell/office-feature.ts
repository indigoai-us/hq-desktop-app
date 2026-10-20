/** Company-scoped native Office beta. Missing flags and unsupported hosts stay closed. */
import type { PlatformAdapter } from "@hq/platform";
import { isIndigoCompany, type GateCompany } from "./indigo-only-gates.js";

export const NATIVE_OFFICE_FLAG = "meetings.native";

export async function resolveOfficeFeature(
  adapter: PlatformAdapter,
  company: GateCompany | null | undefined,
  signedIn: boolean,
): Promise<boolean> {
  if (!signedIn || adapter.kind !== "desktop" || adapter.capabilities?.nativeCalls !== true ||
      !company?.uid || !isIndigoCompany(company)) return false;
  try {
    return await adapter.identity.hasCompanyFeature?.(NATIVE_OFFICE_FLAG, company.uid) === true;
  } catch {
    return false;
  }
}
