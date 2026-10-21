/** Indigo-only native beta: both the slug and company flag are required.
 * A registry override alone cannot expand this beta to other companies. */
import type { PlatformAdapter } from "@hq/platform";
import { isIndigoCompany, type GateCompany } from "./indigo-only-gates.js";

export const NATIVE_OFFICE_FLAG = "meetings.native";

export async function readOfficeFeature(
  adapter: PlatformAdapter,
  company: GateCompany | null | undefined,
  signedIn: boolean,
): Promise<boolean | null> {
  if (!signedIn || adapter.kind !== "desktop" || adapter.capabilities?.nativeCalls !== true ||
      !company?.uid || !isIndigoCompany(company)) return false;
  try {
    if (adapter.identity.readCompanyFeature) return await adapter.identity.readCompanyFeature(NATIVE_OFFICE_FLAG, company.uid);
    return await adapter.identity.hasCompanyFeature?.(NATIVE_OFFICE_FLAG, company.uid) === true;
  } catch {
    return null;
  }
}

export async function resolveOfficeFeature(adapter: PlatformAdapter, company: GateCompany | null | undefined, signedIn: boolean): Promise<boolean> {
  return await readOfficeFeature(adapter, company, signedIn) === true;
}
