import { describe, expect, it, vi } from "vitest";
import type { PlatformAdapter } from "@hq/platform";
import { resolveOfficeFeature } from "./office-feature.js";

function host(enabled: unknown = true) {
  const read = vi.fn(async () => enabled);
  const adapter = { kind: "desktop", capabilities: { nativeCalls: true }, identity: { hasCompanyFeature: read } } as unknown as PlatformAdapter;
  return { adapter, read };
}
const company = { uid: "cmp_test", slug: "indigo" };
describe("native Office company gate", () => {
  it("reads the selected company's flag, never the person's aggregate flag", async () => {
    const { adapter, read } = host();
    expect(await resolveOfficeFeature(adapter, company, true)).toBe(true);
    expect(read).toHaveBeenCalledExactlyOnceWith("meetings.native", "cmp_test");
  });
  it.each([false, undefined, null, "true"])("fails closed for %s", async (value) => {
    const { adapter } = host(false);
    adapter.identity.hasCompanyFeature = async () => value as boolean;
    expect(await resolveOfficeFeature(adapter, company, true)).toBe(false);
  });
  it("refuses other companies, personal scope, signed-out and browser hosts without a flag read", async () => {
    const { adapter, read } = host();
    expect(await resolveOfficeFeature(adapter, { uid: "cmp_other", slug: "other" }, true)).toBe(false);
    expect(await resolveOfficeFeature(adapter, null, true)).toBe(false);
    expect(await resolveOfficeFeature(adapter, company, false)).toBe(false);
    expect(await resolveOfficeFeature({ ...adapter, kind: "web" }, company, true)).toBe(false);
    expect(await resolveOfficeFeature({ ...adapter, capabilities: { ...adapter.capabilities, nativeCalls: false } }, company, true)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
  it("refuses unavailable readers and rejected requests", async () => {
    const { adapter } = host();
    adapter.identity.hasCompanyFeature = undefined;
    expect(await resolveOfficeFeature(adapter, company, true)).toBe(false);
    adapter.identity.hasCompanyFeature = async () => { throw new Error("offline"); };
    expect(await resolveOfficeFeature(adapter, company, true)).toBe(false);
  });
});
